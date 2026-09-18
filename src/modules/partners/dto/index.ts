import { Type } from 'class-transformer';
import { IsArray, IsEmail, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

export class PartnerContactDto {
  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string;
}

export class PartnerAddressDto {
  @IsOptional() @IsString() @MaxLength(200) street?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) state?: string;
  @IsOptional() @IsString() @MaxLength(120) country?: string;
  @IsOptional() @IsString() @MaxLength(20) zip?: string;
}

export class CreatePartnerDto {
  /**
   * Which way people flow: a client we supply people to, or a vendor that
   * supplies people to us. Chosen once — it decides what the company carries.
   */
  @IsIn(['client', 'vendor'])
  category: 'client' | 'vendor';

  @IsString() @MaxLength(200)
  companyName: string;

  @IsOptional() @IsString() @MaxLength(200)
  displayName?: string;

  /** A client's industry, or a vendor's service category — one field either way. */
  @IsOptional() @IsString() @MaxLength(120)
  sector?: string;

  @IsOptional() @IsString() @MaxLength(300)
  website?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string;

  @IsOptional() @ValidateNested() @Type(() => PartnerContactDto)
  primaryContact?: PartnerContactDto;

  // ── vendor-only, ignored for a client ──
  @IsOptional() @IsString() @MaxLength(60)
  taxId?: string;

  @IsOptional() @IsString() @MaxLength(3)
  currency?: string;

  @IsOptional() @ValidateNested() @Type(() => PartnerAddressDto)
  billingAddress?: PartnerAddressDto;
}

export class UpdatePartnerDto {
  @IsOptional() @IsString() @MaxLength(200)
  companyName?: string;

  @IsOptional() @IsString() @MaxLength(200)
  displayName?: string;

  @IsOptional() @IsString() @MaxLength(120)
  sector?: string;

  @IsOptional() @IsString() @MaxLength(300)
  website?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string;

  @IsOptional() @ValidateNested() @Type(() => PartnerContactDto)
  primaryContact?: PartnerContactDto;

  @IsOptional() @IsIn(['active', 'inactive', 'archived'])
  status?: string;
}
