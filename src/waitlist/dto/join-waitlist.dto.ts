import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsISO8601 } from 'class-validator';

export class JoinWaitlistDto {
  @ApiProperty({ example: 2 })
  @IsInt()
  doctorId!: number;

  @ApiProperty({ example: '2026-08-20T09:00:00.000Z' })
  @IsISO8601()
  startTime!: string;
}