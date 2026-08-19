import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, ValidateNested } from 'class-validator';
import { ScheduleEntryDto } from './schedule-entry.dto';

export class UpsertScheduleDto {
  @ApiProperty({ type: [ScheduleEntryDto] })
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => ScheduleEntryDto)
  entries: ScheduleEntryDto[];
}
