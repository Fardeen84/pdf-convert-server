import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { basename, extname, join } from 'path';
import { Semaphore } from '../common/semaphore';

export type Target = 'pdf' | 'docx' | 'xlsx' | 'pptx';
export const TARGETS: Target[] = ['pdf', 'docx', 'xlsx', 'pptx'];

/** Formats LibreOffice can turn into PDF. */
export const OFFICE_EXTS = [
  '.doc', '.docx', '.odt', '.rtf', '.txt',
  '.xls', '.xlsx', '.ods', '.csv',
  '.ppt', '.pptx', '.odp',
];

export interface ConvertResult {
  outPath: string;
  outName: string;
  note: string;
  workDir: string;
}

const MIME: Record<Target, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const mimeFor = (t: Target) => MIME[t];

@Injectable()
export class ConvertService {
  private readonly log = new Logger('ConvertService');
  private readonly jobs = new Semaphore(Number(process.env.MAX_JOBS ?? 2));
  private readonly timeoutMs = Number(process.env.JOB_TIMEOUT_S ?? 120) * 1000;
  private readonly python = process.env.PYTHON_BIN ?? 'python3';
  private readonly script = join(__dirname, '..', '..', 'python', 'convert.py');

  get queued() {
    return this.jobs.queued;
  }

  /** Validates input type vs target, then converts. Caller must delete `workDir` afterwards. */
  async convert(
    uploadPath: string,
    originalName: string,
    target: Target,
    password?: string,
  ): Promise<ConvertResult> {
    const ext = extname(originalName).toLowerCase();
    if (target === 'pdf' && !OFFICE_EXTS.includes(ext)) {
      throw new BadRequestException(`Unsupported file type "${ext}". Supported: ${OFFICE_EXTS.join(' ')}`);
    }
    if (target !== 'pdf' && ext !== '.pdf') {
      throw new BadRequestException(`Converting to ${target} needs a .pdf file`);
    }

    const workDir = join(tmpdir(), `mrigconv-${randomUUID()}`);
    await fs.mkdir(workDir, { recursive: true });
    const stem = basename(originalName, ext).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80) || 'document';
    const input = join(workDir, `input${ext}`);
    await fs.rename(uploadPath, input).catch(async () => {
      await fs.copyFile(uploadPath, input);
      await fs.unlink(uploadPath).catch(() => undefined);
    });

    try {
      const out = await this.jobs.run(() =>
        target === 'pdf' ? this.officeToPdf(input, workDir) : this.pdfTo(target, input, workDir, password),
      );
      return { outPath: out.path, outName: `${stem}.${target}`, note: out.note, workDir };
    } catch (e) {
      await this.cleanup(workDir);
      throw e;
    }
  }

  async cleanup(dir: string) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  // ---- Office -> PDF (LibreOffice) -------------------------------------------------

  private async officeToPdf(input: string, workDir: string) {
    // A private profile per job: LibreOffice allows only one instance per profile,
    // so concurrent jobs sharing the default one would fail or hang.
    const profile = join(workDir, 'lo-profile');
    const args = [
      `-env:UserInstallation=file://${profile}`,
      '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard',
      '--convert-to', 'pdf', '--outdir', workDir, input,
    ];
    await this.run('soffice', args, 'Office conversion');
    const out = join(workDir, 'input.pdf');
    try {
      await fs.access(out);
    } catch {
      throw new UnprocessableEntityException('Could not convert this file (it may be corrupt or password protected).');
    }
    return { path: out, note: 'ok' };
  }

  // ---- PDF -> DOCX / XLSX / PPTX (python) -----------------------------------------

  private async pdfTo(target: Target, input: string, workDir: string, password?: string) {
    const out = join(workDir, `output.${target}`);
    const args = [this.script, target, input, out];
    if (password) args.push('--password', password);
    const stdout = await this.run(this.python, args, 'PDF conversion');
    let note = 'ok';
    try {
      note = JSON.parse(stdout.trim().split('\n').pop() ?? '{}').note ?? 'ok';
    } catch {
      /* note is optional */
    }
    await fs.access(out).catch(() => {
      throw new UnprocessableEntityException('Conversion produced no output.');
    });
    return { path: out, note };
  }

  private run(cmd: string, args: string[], label: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      execFile(cmd, args, { timeout: this.timeoutMs, maxBuffer: 10 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
        if (!err) {
          this.log.log(`${label} ok in ${Date.now() - started}ms`);
          return resolve(stdout);
        }
        const e = err as { message: string; killed?: boolean; code?: number | string };
        this.log.warn(`${label} failed: ${(stderr || e.message).toString().slice(0, 500)}`);
        if (e.code === 'ENOENT') {
          return reject(new InternalServerErrorException(`${cmd} is not installed on the server`));
        }
        if (e.killed) {
          return reject(new UnprocessableEntityException('Conversion took too long and was cancelled.'));
        }
        if (e.code === 2) {
          // convert.py exit code 2: locked / empty PDF; message is meant for the user
          return reject(new UnprocessableEntityException(stderr.toString().trim() || 'Invalid PDF'));
        }
        reject(new UnprocessableEntityException('Could not convert this file.'));
      });
    });
  }
}
