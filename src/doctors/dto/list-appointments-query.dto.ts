import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class ListAppointmentsQuery {
  @ApiPropertyOptional({
    example: '2026-08-23',
    description: 'Inclusive start date (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-08-29',
    description: 'Inclusive end date (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString()
  to?: string;
}
