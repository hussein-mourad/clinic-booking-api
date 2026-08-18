import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class SetSlotDurationDto {
  @ApiProperty({ enum: [15, 30, 60], example: 30 })
  @IsIn([15, 30, 60])
  slotDurationMin: number;
}