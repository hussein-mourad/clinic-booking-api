import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class AnalyticsQuery {
  @ApiProperty({ example: '2026-08', description: 'Month to aggregate (YYYY-MM)' })
  @Matches(/^[0-9]{4}-(0[1-9]|1[0-2])$/, {
    message: 'month must be in YYYY-MM format',
  })
  month: string;
}