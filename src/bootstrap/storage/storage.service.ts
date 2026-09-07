import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';

import { DocumentFileEntity } from './document-file.entity';

export interface SaveFileInput {
  organizationId: string;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
  uploadedBy?: string | null;
  category?: string;
}

export interface StoredFileMeta {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: Date;
}

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — onboarding docs
const BLOCKED_EXT = new Set([
  'exe', 'bat', 'cmd', 'com', 'msi', 'scr', 'pif', 'vbs', 'wsh', 'ps1',
]);
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Pluggable file storage. Ported from the monolith's UploadService S3 mechanics
 * (`<orgId>/<uuid>.<ext>` keys, PutObject, private bucket) but with a
 * Postgres-`bytea` fallback so dev/CI run with no S3 at all. Bytes are served
 * ONLY via the authenticated byte-proxy (`getBytes`); no presigned URL is ever
 * handed to a client.
 *
 * Driver selection is by whether S3 creds are present (`S3_ACCESS_KEY` +
 * `S3_SECRET_KEY`), mirroring the monolith's `s3Enabled` gate — the moment those
 * env vars land the exact same code path uses real S3.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3Enabled: boolean;
  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint: string;
  private s3Client: S3Client | null = null;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(DocumentFileEntity)
    private readonly files: Repository<DocumentFileEntity>,
  ) {
    const accessKey = this.config.get<string>('S3_ACCESS_KEY') || '';
    const secretKey = this.config.get<string>('S3_SECRET_KEY') || '';
    this.bucket = this.config.get<string>('S3_BUCKET') || 's3-nugenova';
    this.region = this.config.get<string>('S3_REGION') || 'ap-south-1';
    this.endpoint = this.config.get<string>('S3_ENDPOINT') || '';
    this.s3Enabled = !!(accessKey && secretKey);

    if (this.s3Enabled) {
      this.s3Client = new S3Client({
        ...(this.endpoint ? { endpoint: this.endpoint, forcePathStyle: true } : {}),
        region: this.region,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      });
    }
    this.logger.log(
      `StorageService driver = ${this.s3Enabled ? 's3' : 'db'} (bucket ${this.bucket})`,
    );
  }

  get driver(): 's3' | 'db' {
    return this.s3Enabled ? 's3' : 'db';
  }

  private extFor(mime: string, name: string): string {
    return MIME_TO_EXT[mime] || (name.split('.').pop() || 'bin').toLowerCase();
  }

  async save(input: SaveFileInput): Promise<StoredFileMeta> {
    if (!input.buffer?.length) throw new BadRequestException('Empty file');
    if (input.buffer.length > MAX_BYTES) {
      throw new BadRequestException('File exceeds the 25 MB limit');
    }
    const ext = this.extFor(input.mimeType, input.originalName);
    if (BLOCKED_EXT.has(ext)) {
      throw new BadRequestException(`Files of type .${ext} are not allowed`);
    }

    const entity = this.files.create({
      organizationId: input.organizationId,
      uploadedBy: input.uploadedBy ?? null,
      originalName: input.originalName.slice(0, 255),
      mimeType: input.mimeType,
      size: input.buffer.length,
      category: input.category ?? null,
      driver: this.driver,
      isDeleted: false,
    });

    if (this.s3Enabled && this.s3Client) {
      const storageKey = `${input.organizationId}/${randomUUID()}.${ext}`;
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
          Body: input.buffer,
          ContentType: input.mimeType,
          Metadata: {
            'original-name': input.originalName.slice(0, 255),
            'uploaded-by': input.uploadedBy || '',
          },
        }),
      );
      entity.storageKey = storageKey;
      entity.content = null;
    } else {
      entity.storageKey = null;
      entity.content = input.buffer;
    }

    const saved = await this.files.save(entity);
    return this.toMeta(saved);
  }

  toMeta(f: DocumentFileEntity): StoredFileMeta {
    return {
      id: f.id,
      originalName: f.originalName,
      mimeType: f.mimeType,
      size: f.size,
      createdAt: f.createdAt,
    };
  }

  async getMeta(id: string): Promise<DocumentFileEntity> {
    const f = await this.files.findOne({ where: { id, isDeleted: false } });
    if (!f) throw new NotFoundException('File not found');
    return f;
  }

  /** Return the raw bytes for the byte-proxy download (both drivers). */
  async getBytes(f: DocumentFileEntity): Promise<Buffer> {
    if (f.driver === 's3' && f.storageKey && this.s3Client) {
      const res = await this.s3Client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: f.storageKey }),
      );
      const arr = await res.Body!.transformToByteArray();
      return Buffer.from(arr);
    }
    if (f.content) return f.content;
    throw new NotFoundException('File content unavailable');
  }

  // NOTE: presigned-URL generation is intentionally NOT provided. Confidential
  // documents must be served only through the authenticated byte-proxy
  // (`getBytes` behind JwtAuthGuard); a presigned S3 URL is auth-free and
  // copy-pasteable from the Network tab, which the product must never expose.
}
