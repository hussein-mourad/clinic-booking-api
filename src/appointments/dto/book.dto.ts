import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, Min } from 'class-validator';

export class BookDto {
  @ApiProperty({ example: 29 })
  @IsInt()
  @Min(1)
  doctorId: number;

  @ApiProperty({
    example: '2026-08-23T10:00:00.000Z',
    description: 'Slot start (UTC, on the slot grid)',
  })
  @IsDateString()
  startTime: string;
}
