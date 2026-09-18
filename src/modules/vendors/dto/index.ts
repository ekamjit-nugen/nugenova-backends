import {
  IsArray, IsBoolean, IsEmail, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';

export class VendorPrimaryContactDto {
  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string;
}

export class VendorBillingAddressDto {
  @IsOptional() @IsString() @MaxLength(200) street?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) state?: string;
  @IsOptional() @IsString() @MaxLength(120) country?: string;
  @IsOptional() @IsString() @MaxLength(20) zip?: string;
}

export class CreateVendorDto {
  @IsString() @MaxLength(200)
  companyName: string;

  @IsOptional() @IsString() @MaxLength(200)
  displayName?: string;

  @IsOptional() @IsString() @MaxLength(120)
  serviceCategory?: string;

  @IsOptional() @IsString() @MaxLength(300)
  website?: string;

  @IsOptional() @IsString() @MaxLength(60)
  taxId?: string;

  @IsOptional() @IsString() @MaxLength(3)
  currency?: string;

  @IsOptional() @IsBoolean()
  timeTrackingEnabled?: boolean;

  @IsOptional()
  billingAddress?: VendorBillingAddressDto;

  @IsOptional()
  primaryContact?: VendorPrimaryContactDto;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string;
}

export class UpdateVendorDto extends CreateVendorDto {
  @IsOptional() @IsString() @MaxLength(200)
  declare companyName: string;

  @IsOptional() @IsIn(['active', 'inactive', 'archived'])
  status?: 'active' | 'inactive' | 'archived';

  @IsOptional() @IsIn(['invited', 'agreements_pending', 'active', 'suspended'])
  onboardingStatus?: 'invited' | 'agreements_pending' | 'active' | 'suspended';
}

export class CreateVendorContactDto {
  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string;

  @IsOptional() @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateVendorContactDto extends CreateVendorContactDto {
  @IsOptional() @IsString() @MaxLength(200)
  declare name: string;
}

export class CreateVendorEmployeeDto {
  @IsString() @MaxLength(200)
  name: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(120)
  designation?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  skills?: string[];

  @IsOptional() @IsIn(['contract', 'full_time', 'part_time', 'freelance'])
  employmentType?: 'contract' | 'full_time' | 'part_time' | 'freelance';

  @IsOptional() @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';

  // Money: a rate can be 0 (unpaid intern-style placements) but never negative,
  // and the cap keeps a typo out of the billing figures.
  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000)
  rateAmount?: number;

  @IsOptional() @IsString() @MaxLength(3)
  rateCurrency?: string;

  @IsOptional() @IsIn(['hour', 'day', 'month'])
  rateUnit?: 'hour' | 'day' | 'month';

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string;
}

export class UpdateVendorEmployeeDto extends CreateVendorEmployeeDto {
  @IsOptional() @IsString() @MaxLength(200)
  declare name: string;
}
