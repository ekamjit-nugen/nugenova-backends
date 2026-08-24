import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OnboardingDocumentRequestEntity } from '../entities/onboarding-document-request.entity';
import { OrganizationEntity } from '../../organization/entities/organization.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { DocumentTemplateService } from './document-template.service';
import { MailService } from '../../../bootstrap/mail/mail.service';
import {
  documentsRequestedEmail,
  documentApprovedEmail,
  documentRejectedEmail,
  orgActivatedEmail,
} from '../../../bootstrap/mail/email-layout';
import { RequestDocumentsDto, SubmitDocumentDto } from '../dto';

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @InjectRepository(OnboardingDocumentRequestEntity)
    private readonly requests: Repository<OnboardingDocumentRequestEntity>,
    @InjectRepository(OrganizationEntity)
    private readonly orgs: Repository<OrganizationEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly templates: DocumentTemplateService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  private frontendUrl(): string {
    return (
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:3111'
    ).replace(/\/$/, '');
  }

  private async getOrg(orgId: string): Promise<OrganizationEntity> {
    const org = await this.orgs.findOne({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  private async ownerEmail(org: OrganizationEntity): Promise<string | null> {
    if (!org.ownerId) return null;
    const u = await this.users.findOne({ where: { id: org.ownerId } });
    return u?.email ?? null;
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  private adminView(r: OnboardingDocumentRequestEntity) {
    return {
      id: r.id,
      templateId: r.templateId,
      title: r.title,
      description: r.description,
      category: r.category,
      bodyHtml: r.bodyHtml,
      requiresSignature: r.requiresSignature,
      requiresUpload: r.requiresUpload,
      fields: r.fields || [],
      sourceFileId: r.sourceFileId,
      status: r.status,
      signature: r.signature,
      submittedFileId: r.submittedFileId,
      approval: r.approval,
      sharedAt: r.sharedAt,
      submittedAt: r.submittedAt,
    };
  }

  /** Portal-safe view for the org owner (no internal actor ids). */
  private ownerView(r: OnboardingDocumentRequestEntity) {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      category: r.category,
      bodyHtml: r.bodyHtml,
      requiresSignature: r.requiresSignature,
      requiresUpload: r.requiresUpload,
      fields: r.fields || [],
      sourceFileId: r.sourceFileId,
      status: r.status,
      signature: r.signature
        ? {
            signerName: r.signature.signerName,
            signedAt: r.signature.signedAt,
            method: r.signature.method,
          }
        : null,
      submittedFileId: r.submittedFileId,
      rejectionNote:
        r.status === 'rejected' ? r.approval?.note ?? null : null,
      submittedAt: r.submittedAt,
    };
  }

  private summarize(rows: OnboardingDocumentRequestEntity[]) {
    const total = rows.length;
    const approved = rows.filter((r) => r.status === 'approved').length;
    const submitted = rows.filter((r) => r.status === 'submitted').length;
    const rejected = rows.filter((r) => r.status === 'rejected').length;
    const requested = rows.filter((r) => r.status === 'requested').length;
    return {
      total,
      approved,
      submitted,
      rejected,
      requested,
      pending: total - approved,
      allApproved: total > 0 && approved === total,
    };
  }

  // ── Super-admin: request documents ───────────────────────────────────────────

  async requestDocuments(
    orgId: string,
    dto: RequestDocumentsDto,
    requestedBy: string,
  ) {
    const org = await this.getOrg(orgId);

    const created: OnboardingDocumentRequestEntity[] = [];
    const skipped: string[] = [];

    // Never request the same library document twice for an org — skip any
    // template already requested (in any non-deleted state).
    const existing = await this.requests.find({
      where: { organizationId: orgId, isDeleted: false },
    });
    const requestedTemplateIds = new Set(
      existing.map((r) => r.templateId).filter(Boolean) as string[],
    );

    const tpls = await this.templates.resolveByKeys(dto.templateKeys || []);
    for (const t of tpls) {
      if (requestedTemplateIds.has(t.id)) {
        skipped.push(t.name);
        continue;
      }
      created.push(
        await this.requests.save(
          this.requests.create({
            organizationId: orgId,
            templateId: t.id,
            title: t.name,
            description: t.description,
            category: t.category,
            bodyHtml: t.bodyHtml,
            requiresSignature: t.requiresSignature,
            requiresUpload: t.requiresUpload,
            fields: t.fields,
            status: 'requested',
            requestedBy,
            sharedAt: new Date(),
          }),
        ),
      );
    }
    for (const c of dto.customDocuments || []) {
      const fields = (c.fields as any) ?? null;
      const hasSignatureField =
        Array.isArray(fields) &&
        fields.some(
          (f: any) => f.type === 'signature' || f.type === 'initials',
        );
      // A PDF-with-fields document is filled/signed in place: signature comes
      // from a placed field, and there's no separate file to upload.
      const isPdfFieldDoc = !!c.sourceFileId;
      created.push(
        await this.requests.save(
          this.requests.create({
            organizationId: orgId,
            templateId: null,
            title: c.title.trim(),
            description: c.description ?? null,
            category: c.category || 'other',
            bodyHtml: c.bodyHtml ?? null,
            requiresSignature: isPdfFieldDoc
              ? hasSignatureField
              : (c.requiresSignature ?? false),
            requiresUpload: isPdfFieldDoc
              ? false
              : (c.requiresUpload ?? !c.requiresSignature),
            fields,
            sourceFileId: c.sourceFileId ?? null,
            status: 'requested',
            requestedBy,
            sharedAt: new Date(),
          }),
        ),
      );
    }

    if (!created.length) {
      // Everything asked for was already requested — a no-op, not an error.
      if (skipped.length) {
        return { created: [], count: 0, skipped };
      }
      throw new BadRequestException(
        'No documents to request — provide templateKeys and/or customDocuments',
      );
    }

    // Keep the org in the onboarding gate while documents are outstanding.
    if (org.status === 'active') {
      org.status = 'onboarding';
      await this.orgs.save(org);
    }

    if (dto.notify !== false) {
      await this.sendDocumentsRequestedEmail(org);
    }

    return {
      created: created.map((r) => this.adminView(r)),
      count: created.length,
      skipped,
    };
  }

  private async sendDocumentsRequestedEmail(org: OrganizationEntity) {
    const to = await this.ownerEmail(org);
    if (!to) return;
    const rows = await this.requests.find({
      where: { organizationId: org.id, isDeleted: false },
    });
    const outstanding = rows.filter((r) => r.status !== 'approved');
    if (!outstanding.length) return;
    const { subject, html } = documentsRequestedEmail({
      orgName: org.name,
      documentTitles: outstanding.map((r) => r.title),
      submitUrl: `${this.frontendUrl()}/onboarding`,
    });
    await this.mail.send({
      to,
      subject,
      html,
      category: 'onboarding.documents_requested',
      organizationId: org.id,
    });
  }

  async adminList(orgId: string) {
    const org = await this.getOrg(orgId);
    const rows = await this.requests.find({
      where: { organizationId: orgId, isDeleted: false },
      order: { sharedAt: 'ASC' },
    });
    return {
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        status: org.status,
      },
      documents: rows.map((r) => this.adminView(r)),
      summary: this.summarize(rows),
    };
  }

  // ── Owner: view + submit ─────────────────────────────────────────────────────

  async ownerStatus(orgId: string) {
    const org = await this.getOrg(orgId);
    const rows = await this.requests.find({
      where: { organizationId: orgId, isDeleted: false },
      order: { sharedAt: 'ASC' },
    });
    return {
      organization: { id: org.id, name: org.name, status: org.status },
      documents: rows.map((r) => this.ownerView(r)),
      summary: this.summarize(rows),
    };
  }

  private async ownedRequest(orgId: string, id: string) {
    const r = await this.requests.findOne({
      where: { id, organizationId: orgId, isDeleted: false },
    });
    if (!r) throw new NotFoundException('Document not found');
    return r;
  }

  async ownerGetDocument(orgId: string, id: string) {
    return this.ownerView(await this.ownedRequest(orgId, id));
  }

  async submitDocument(
    orgId: string,
    id: string,
    dto: SubmitDocumentDto,
    userId: string,
    ip?: string,
    ua?: string,
  ) {
    const r = await this.ownedRequest(orgId, id);
    if (r.status === 'approved') {
      throw new BadRequestException('This document is already approved');
    }

    if (r.requiresSignature) {
      if (!dto.signerName || !dto.signerName.trim()) {
        throw new BadRequestException('A signer name is required to sign');
      }
      r.signature = {
        signerName: dto.signerName.trim(),
        signerEmail: dto.signerEmail ?? null,
        signedByUserId: userId,
        signedAt: new Date().toISOString(),
        ipAddress: ip ?? null,
        userAgent: ua ?? null,
        method: dto.method || (dto.signatureFileId ? 'drawn' : 'typed'),
        signatureFileId: dto.signatureFileId ?? null,
        fieldValues: (dto.fieldValues || []).reduce<Record<string, string>>(
          (acc, f) => {
            if (f.value != null) acc[f.key] = f.value;
            return acc;
          },
          {},
        ),
      };
    }

    if (r.requiresUpload) {
      if (!dto.submittedFileId) {
        throw new BadRequestException('An uploaded file is required');
      }
      r.submittedFileId = dto.submittedFileId;
    }

    r.status = 'submitted';
    r.submittedAt = new Date();
    // Clear a prior rejection note now that it's re-submitted.
    if (r.approval && r.approval.note) r.approval = null;
    await this.requests.save(r);
    return this.ownerView(r);
  }

  // ── Super-admin: approve / reject / activate ─────────────────────────────────

  private async getRequest(id: string) {
    const r = await this.requests.findOne({
      where: { id, isDeleted: false },
    });
    if (!r) throw new NotFoundException('Document not found');
    return r;
  }

  async approveDocument(id: string, actedBy: string, note?: string) {
    const r = await this.getRequest(id);
    if (r.status !== 'submitted') {
      throw new BadRequestException(
        'Only a submitted document can be approved',
      );
    }
    r.status = 'approved';
    r.approval = {
      actedBy,
      actedAt: new Date().toISOString(),
      note: note ?? null,
    };
    await this.requests.save(r);

    const org = await this.getOrg(r.organizationId);
    const rows = await this.requests.find({
      where: { organizationId: org.id, isDeleted: false },
    });
    const summary = this.summarize(rows);

    if (summary.allApproved) {
      await this.activate(org, actedBy);
    } else {
      const to = await this.ownerEmail(org);
      if (to) {
        const { subject, html } = documentApprovedEmail({
          orgName: org.name,
          documentTitle: r.title,
          remaining: summary.pending,
          submitUrl: `${this.frontendUrl()}/onboarding`,
        });
        await this.mail.send({
          to,
          subject,
          html,
          category: 'onboarding.document_approved',
          organizationId: org.id,
        });
      }
    }

    return { document: this.adminView(r), summary, orgStatus: org.status };
  }

  async rejectDocument(id: string, actedBy: string, note: string) {
    const r = await this.getRequest(id);
    if (r.status !== 'submitted') {
      throw new BadRequestException(
        'Only a submitted document can be rejected',
      );
    }
    r.status = 'rejected';
    r.approval = { actedBy, actedAt: new Date().toISOString(), note };
    await this.requests.save(r);

    const org = await this.getOrg(r.organizationId);
    const to = await this.ownerEmail(org);
    if (to) {
      const { subject, html } = documentRejectedEmail({
        orgName: org.name,
        documentTitle: r.title,
        note,
        submitUrl: `${this.frontendUrl()}/onboarding`,
      });
      await this.mail.send({
        to,
        subject,
        html,
        category: 'onboarding.document_rejected',
        organizationId: org.id,
      });
    }
    return { document: this.adminView(r) };
  }

  /** Flip the org to active + send the welcome email. */
  private async activate(org: OrganizationEntity, actedBy: string) {
    if (org.status !== 'active') {
      org.status = 'active';
      await this.orgs.save(org);
      this.logger.log(`Org '${org.name}' (${org.id}) activated by ${actedBy}`);
    }
    const to = await this.ownerEmail(org);
    if (to) {
      const { subject, html } = orgActivatedEmail({
        orgName: org.name,
        loginUrl: `${this.frontendUrl()}/login`,
      });
      await this.mail.send({
        to,
        subject,
        html,
        category: 'onboarding.org_activated',
        organizationId: org.id,
      });
    }
  }

  async activateOrg(orgId: string, actedBy: string, force = false) {
    const org = await this.getOrg(orgId);
    const rows = await this.requests.find({
      where: { organizationId: orgId, isDeleted: false },
    });
    const summary = this.summarize(rows);
    if (!force && !summary.allApproved) {
      throw new BadRequestException(
        'Every requested document must be approved before activation (or force it)',
      );
    }
    await this.activate(org, actedBy);
    return { organization: { id: org.id, name: org.name, status: org.status } };
  }
}
