import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class ListSlotsQuery {
  @ApiProperty({
    example: '2026-08-23',
    description: 'Inclusive start date (YYYY-MM-DD)',
  })
  @IsDateString()
  from: string;

  @ApiProperty({
    example: '2026-08-29',
    description: 'Inclusive end date (YYYY-MM-DD)',
  })
  @IsDateString()
  to: string;
}
