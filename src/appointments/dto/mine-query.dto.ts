import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBooleanString, IsOptional } from 'class-validator';

export class MineQuery {
  @ApiPropertyOptional({
    example: 'true',
    description:
      'Include past/completed appointments (default: only in-progress scheduled ones)',
  })
  @IsOptional()
  @IsBooleanString()
  includeHistory?: string;
}