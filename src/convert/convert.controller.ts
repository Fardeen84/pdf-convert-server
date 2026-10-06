import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { diskStorage } from 'multer';
import { tmpdir } from 'os';
import { extname } from 'path';
import { ApiKeyGuard } from '../common/api-key.guard';
import { ConvertService, OFFICE_EXTS, Target, TARGETS, mimeFor } from './convert.service';

const MAX_BYTES = Number(process.env.MAX_FILE_MB ?? 25) * 1024 * 1024;

@Controller()
export class ConvertController {
  constructor(private readonly svc: ConvertService) {}

  @SkipThrottle()
  @Get('health')
  health() {
    return { ok: true, queued: this.svc.queued };
  }

  @SkipThrottle()
  @Get('formats')
  formats() {
    return {
      toPdf: OFFICE_EXTS,
      fromPdf: TARGETS.filter((t) => t !== 'pdf'),
      maxFileMB: MAX_BYTES / 1024 / 1024,
    };
  }

  /**
   * POST /convert/:target   (multipart: file, optional password)
   *   target = pdf  -> file is .doc/.docx/.xls/.xlsx/.ppt/.pptx/.odt/.ods/.odp/.rtf/.txt/.csv
   *   target = docx | xlsx | pptx -> file is a .pdf
   * The converted file is streamed back; nothing is kept on the server.
   */
  @Post('convert/:target')
  @HttpCode(200)
  @UseGuards(ApiKeyGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, file, cb) => cb(null, `upload-${randomUUID()}${extname(file.originalname).toLowerCase()}`),
      }),
      limits: { fileSize: MAX_BYTES, files: 1 },
    }),
  )
  async convert(
    @Param('target') target: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('password') password: string | undefined,
    @Res() res: Response,
  ) {
    if (!file) throw new BadRequestException('Send the document in a multipart field named "file"');
    let result;
    try {
      if (!TARGETS.includes(target as Target)) {
        throw new BadRequestException(`Unknown target "${target}". Use one of: ${TARGETS.join(', ')}`);
      }
      // multer decodes non-ASCII names as latin1; restore UTF-8 so Hindi etc. names survive.
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      result = await this.svc.convert(file.path, name, target as Target, password || undefined);
    } catch (e) {
      // Any rejection: make sure the upload does not stay on disk.
      await fs.unlink(file.path).catch(() => undefined);
      throw e;
    }

    res.setHeader('Content-Type', mimeFor(target as Target));
    res.setHeader('X-Convert-Note', result.note);
    res.setHeader('Access-Control-Expose-Headers', 'X-Convert-Note, Content-Disposition');
    res.download(result.outPath, result.outName, () => void this.svc.cleanup(result.workDir));
  }
}
