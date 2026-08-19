import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class MineQuery {
  @ApiPropertyOptional({
    enum: ['scheduled', 'cancelled', 'completed'],
    description: 'Filter by appointment status (default: scheduled)',
  })
  @IsOptional()
  @IsIn(['scheduled', 'cancelled', 'completed'])
  status?: 'scheduled' | 'cancelled' | 'completed';
}
