import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '../roles.decorator';

export class RegisterDto {
  @ApiProperty({ example: 'patient@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ minLength: 6, maxLength: 72, example: 'secret123' })
  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password: string;

  @ApiProperty({ example: 'Hussein' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ enum: ['patient', 'doctor'], default: 'patient' })
  @IsOptional()
  @IsIn(['patient', 'doctor'] as const)
  role?: UserRole;
}
