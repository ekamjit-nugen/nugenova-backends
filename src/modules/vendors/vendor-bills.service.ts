import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';

import { VendorEntity } from './entities/vendor.entity';
import { VendorEmployeeEntity } from './entities/vendor-employee.entity';
import { VendorBillEntity, VendorBillLine, VendorBillStatus } from './entities/vendor-bill.entity';
import { VendorsCaller } from './vendors.service';
import { CancelVendorBillDto, CreateVendorBillDto, MarkVendorBillPaidDto, UpdateVendorBillDto } from './dto';

/** Money in, money out — two decimals, no floating-point crumbs. */
const money = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Vendor bills — what a vendor charged us for the people they supplied.
 *
 * The first billing surface in the platform: there is no invoice, payment or
 * ledger model to build on, so a bill records what we owe and that we paid it,
 * rather than moving money anywhere.
 *
 * Two rules hold the whole thing together:
 *   • every money figure is recomputed from the lines on write — a client may
 *     suggest totals, it may never decide them;
 *   • a bill is editable only while it is a draft. Once approved it is a
 *     financial record, so a correction means cancelling and raising a new bill.
 */
@Injectable()
export class VendorBillsService {
  constructor(
    @InjectRepository(VendorEntity) private readonly vendors: Repository<VendorEntity>,
    @InjectRepository(VendorEmployeeEntity) private readonly people: Repository<VendorEmployeeEntity>,
    @InjectRepository(VendorBillEntity) private readonly bills: Repository<VendorBillEntity>,
  ) {}

  // ── reading ────────────────────────────────────────────────────────────────

  /** Bills across the org, newest first — the payables queue. */
  async listForOrg(orgId: string, q: { status?: string; vendorId?: string; from?: string; to?: string } = {}) {
    const where: Record<string, unknown> = { organizationId: orgId, isDeleted: false };
    if (this.isStatus(q.status)) where.status = q.status;
    if (q.vendorId) where.vendorId = q.vendorId;
    if (q.from && q.to) where.issueDate = Between(new Date(q.from), new Date(q.to));
    const rows = await this.bills.find({ where, order: { createdAt: 'DESC' } });
    return rows.map((b) => this.view(b));
  }

  async listForVendor(orgId: string, vendorId: string) {
    await this.requireVendor(orgId, vendorId);
    const rows = await this.bills.find({ where: { organizationId: orgId, vendorId, isDeleted: false }, order: { createdAt: 'DESC' } });
    return rows.map((b) => this.view(b));
  }

  async get(orgId: string, id: string) {
    return this.view(await this.requireBill(orgId, id));
  }

  /**
   * What this vendor has cost us: totals by state, and what is still owed.
   * Cancelled bills are excluded — they never were a cost.
   */
  async costSummary(orgId: string, vendorId: string) {
    const vendor = await this.requireVendor(orgId, vendorId);
    const rows = await this.bills.find({ where: { organizationId: orgId, vendorId, isDeleted: false } });
    const sum = (s: VendorBillStatus) => money(rows.filter((b) => b.status === s).reduce((t, b) => t + Number(b.total), 0));
    const paid = sum('paid');
    const approved = sum('approved');
    const draft = sum('draft');
    return {
      currency: vendor.currency,
      bills: rows.filter((b) => b.status !== 'cancelled').length,
      draft,
      approved,
      paid,
      /** Approved but not yet paid — what we actually owe them today. */
      outstanding: approved,
      /** Everything that has been agreed to, whether or not it has been paid. */
      committed: money(approved + paid),
      lifetime: money(draft + approved + paid),
    };
  }

  // ── writing ────────────────────────────────────────────────────────────────

  async create(caller: VendorsCaller, vendorId: string, dto: CreateVendorBillDto) {
    const vendor = await this.requireVendor(caller.orgId, vendorId);
    const lineItems = await this.buildLines(caller.orgId, vendorId, dto.lineItems);
    const totals = this.compute(lineItems, dto.taxPercent ?? 0);

    // The house numbering is count+1; a unique index on (org, number) makes a
    // concurrent double-raise fail loudly instead of silently sharing a number,
    // and we simply take the next one.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return this.view(await this.bills.save(this.bills.create({
          organizationId: caller.orgId,
          vendorId,
          vendorName: vendor.companyName,
          billNumber: await this.nextBillNumber(caller.orgId, attempt),
          vendorInvoiceNumber: dto.vendorInvoiceNumber?.trim() || null,
          period: dto.period?.trim() || null,
          lineItems,
          currency: dto.currency?.toUpperCase() || vendor.currency,
          subtotal: String(totals.subtotal),
          taxPercent: String(money(dto.taxPercent ?? 0)),
          taxAmount: String(totals.taxAmount),
          total: String(totals.total),
          status: 'draft',
          issueDate: dto.issueDate ? new Date(dto.issueDate) : new Date(),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          approvedAt: null, approvedBy: null, paidAt: null, paidBy: null, paymentReference: null,
          cancelReason: null,
          invoiceFileId: dto.invoiceFileId ?? null,
          notes: dto.notes ?? null,
          createdBy: caller.userId,
          isDeleted: false,
        })));
      } catch (e) {
        if (!this.isDuplicateNumber(e)) throw e;
      }
    }
    throw new BadRequestException('Could not allocate a bill number — please try again');
  }

  async update(orgId: string, id: string, dto: UpdateVendorBillDto) {
    const bill = await this.requireBill(orgId, id);
    if (bill.status !== 'draft') {
      throw new BadRequestException(`A ${bill.status} bill cannot be edited — cancel it and raise a new one`);
    }
    if (dto.lineItems !== undefined) bill.lineItems = await this.buildLines(orgId, bill.vendorId, dto.lineItems);
    if (dto.taxPercent !== undefined) bill.taxPercent = String(money(dto.taxPercent));
    if (dto.vendorInvoiceNumber !== undefined) bill.vendorInvoiceNumber = dto.vendorInvoiceNumber?.trim() || null;
    if (dto.period !== undefined) bill.period = dto.period?.trim() || null;
    if (dto.currency !== undefined) bill.currency = dto.currency?.toUpperCase() || bill.currency;
    if (dto.issueDate !== undefined) bill.issueDate = dto.issueDate ? new Date(dto.issueDate) : null;
    if (dto.dueDate !== undefined) bill.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    if (dto.invoiceFileId !== undefined) bill.invoiceFileId = dto.invoiceFileId ?? null;
    if (dto.notes !== undefined) bill.notes = dto.notes ?? null;

    const totals = this.compute(bill.lineItems, Number(bill.taxPercent));
    bill.subtotal = String(totals.subtotal);
    bill.taxAmount = String(totals.taxAmount);
    bill.total = String(totals.total);
    return this.view(await this.bills.save(bill));
  }

  /** Agree the bill: draft → approved. Who approved it is part of the record. */
  async approve(caller: VendorsCaller, id: string) {
    const bill = await this.requireBill(caller.orgId, id);
    if (bill.status === 'approved') return this.view(bill);
    if (bill.status !== 'draft') throw new BadRequestException(`A ${bill.status} bill cannot be approved`);
    if (!bill.lineItems.length) throw new BadRequestException('An empty bill cannot be approved');
    // Someone has to check the money before it is owed; approving your own bill
    // is allowed (small teams), but it is recorded as yours.
    bill.status = 'approved';
    bill.approvedAt = new Date();
    bill.approvedBy = caller.userId;
    return this.view(await this.bills.save(bill));
  }

  /** Record that we paid it: approved → paid. */
  async markPaid(caller: VendorsCaller, id: string, dto: MarkVendorBillPaidDto) {
    const bill = await this.requireBill(caller.orgId, id);
    if (bill.status === 'paid') throw new BadRequestException('This bill is already marked paid');
    if (bill.status !== 'approved') throw new BadRequestException('Approve the bill before marking it paid');
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) throw new BadRequestException('That payment date is not a date');
    if (paidAt.getTime() > Date.now()) throw new BadRequestException('A payment cannot be dated in the future');
    bill.status = 'paid';
    bill.paidAt = paidAt;
    bill.paidBy = caller.userId;
    bill.paymentReference = dto.paymentReference?.trim() || null;
    return this.view(await this.bills.save(bill));
  }

  /** Cancel a bill we will not pay (draft/approved → cancelled). */
  async cancel(orgId: string, id: string, dto: CancelVendorBillDto) {
    const bill = await this.requireBill(orgId, id);
    if (bill.status === 'paid') throw new BadRequestException('A paid bill cannot be cancelled');
    if (bill.status === 'cancelled') return this.view(bill);
    bill.status = 'cancelled';
    bill.cancelReason = dto.reason?.trim() || null;
    return this.view(await this.bills.save(bill));
  }

  /** Only an unpaid, unapproved bill can be deleted; anything else is a record. */
  async remove(orgId: string, id: string) {
    const bill = await this.requireBill(orgId, id);
    if (bill.status === 'approved' || bill.status === 'paid') {
      throw new BadRequestException(`A ${bill.status} bill is a record — cancel it instead of deleting`);
    }
    bill.isDeleted = true;
    await this.bills.save(bill);
    return { id };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Turn the submitted lines into stored ones: the name of a supplied person is
   * resolved from their record (and checked to belong to this vendor), and every
   * amount is computed here.
   */
  private async buildLines(orgId: string, vendorId: string, lines: CreateVendorBillDto['lineItems']): Promise<VendorBillLine[]> {
    const rows = lines ?? [];
    if (!rows.length) throw new BadRequestException('A bill needs at least one line');

    const ids = [...new Set(rows.map((l) => l.vendorEmployeeId).filter(Boolean) as string[])];
    const known = ids.length
      ? await this.people.find({ where: { organizationId: orgId, vendorId, id: In(ids), isDeleted: false } })
      : [];
    const byId = new Map(known.map((p) => [p.id, p]));

    return rows.map((l) => {
      const person = l.vendorEmployeeId ? byId.get(l.vendorEmployeeId) : undefined;
      if (l.vendorEmployeeId && !person) {
        // Billing us for someone this vendor doesn't supply is a mistake worth stopping.
        throw new BadRequestException('A line refers to someone this vendor does not supply');
      }
      const quantity = money(l.quantity);
      const rate = money(l.rate);
      if (quantity < 0 || rate < 0) throw new BadRequestException('Quantities and rates cannot be negative');
      return {
        description: l.description?.trim() || person?.name || 'Services',
        vendorEmployeeId: l.vendorEmployeeId ?? null,
        contractorName: l.contractorName?.trim() || person?.name || null,
        quantity,
        unit: l.unit ?? 'day',
        rate,
        amount: money(quantity * rate),
      };
    });
  }

  private compute(lines: VendorBillLine[], taxPercent: number) {
    const subtotal = money(lines.reduce((t, l) => t + (Number(l.amount) || 0), 0));
    const taxAmount = money(subtotal * ((Number(taxPercent) || 0) / 100));
    return { subtotal, taxAmount, total: money(subtotal + taxAmount) };
  }

  private async nextBillNumber(orgId: string, offset = 0): Promise<string> {
    const count = await this.bills.count({ where: { organizationId: orgId } });
    return `VB-${String(count + 1 + offset).padStart(5, '0')}`;
  }

  private isDuplicateNumber(e: unknown): boolean {
    const code = (e as { code?: string; driverError?: { code?: string } })?.code
      ?? (e as { driverError?: { code?: string } })?.driverError?.code;
    return code === '23505'; // unique_violation
  }

  private isStatus(s?: string): s is VendorBillStatus {
    return s === 'draft' || s === 'approved' || s === 'paid' || s === 'cancelled';
  }

  private async requireVendor(orgId: string, vendorId: string): Promise<VendorEntity> {
    const vendor = await this.vendors.findOne({ where: { id: vendorId, organizationId: orgId, isDeleted: false } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  private async requireBill(orgId: string, id: string): Promise<VendorBillEntity> {
    const bill = await this.bills.findOne({ where: { id, organizationId: orgId, isDeleted: false } });
    if (!bill) throw new NotFoundException('Bill not found');
    return bill;
  }

  /** Numerics come back from Postgres as strings; the API speaks numbers. */
  private view(b: VendorBillEntity) {
    return {
      id: b.id,
      vendorId: b.vendorId,
      vendorName: b.vendorName,
      billNumber: b.billNumber,
      vendorInvoiceNumber: b.vendorInvoiceNumber,
      period: b.period,
      lineItems: b.lineItems ?? [],
      currency: b.currency,
      subtotal: Number(b.subtotal),
      taxPercent: Number(b.taxPercent),
      taxAmount: Number(b.taxAmount),
      total: Number(b.total),
      status: b.status,
      issueDate: b.issueDate,
      dueDate: b.dueDate,
      approvedAt: b.approvedAt,
      approvedBy: b.approvedBy,
      paidAt: b.paidAt,
      paidBy: b.paidBy,
      paymentReference: b.paymentReference,
      cancelReason: b.cancelReason,
      invoiceFileId: b.invoiceFileId,
      notes: b.notes,
      createdAt: b.createdAt,
    };
  }
}
