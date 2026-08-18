import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.decorator';
import { DoctorsService } from './doctors.service';
import { CreateBlockDto } from './dto/create-block.dto';
import { SetSlotDurationDto } from './dto/set-slot-duration.dto';
import { UpsertScheduleDto } from './dto/upsert-schedule.dto';

@ApiTags('doctors')
@ApiBearerAuth()
@Controller('doctors')
@Roles('doctor')
export class DoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  private assertOwn(id: number, user: JwtPayload) {
    if (user.sub !== id) {
      throw new ForbiddenException('You can only manage your own schedule');
    }
  }

  @Get()
  @Roles('patient', 'doctor')
  @ApiOperation({ summary: 'List doctors' })
  @ApiResponse({ status: 200, description: 'Array of doctors' })
  list() {
    return this.doctors.listDoctors();
  }

  @Get(':id/schedule')
  @ApiOperation({ summary: 'Get a doctor weekly schedule' })
  getSchedule(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtPayload) {
    this.assertOwn(id, user);
    return this.doctors.getSchedule(id);
  }

  @Put(':id/schedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replace a doctor weekly schedule' })
  @ApiResponse({ status: 200, description: 'Schedule updated' })
  replaceSchedule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertScheduleDto,
    @CurrentUser() user: JwtPayload,
  ) {
    this.assertOwn(id, user);
    return this.doctors.replaceSchedule(id, dto.entries);
  }

  @Post(':id/blocks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Block a date or time range for a doctor' })
  @ApiResponse({ status: 201, description: 'Block created' })
  addBlock(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateBlockDto,
    @CurrentUser() user: JwtPayload,
  ) {
    this.assertOwn(id, user);
    return this.doctors.addBlock(id, dto);
  }

  @Delete(':id/blocks/:blockId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a blocked date/time range' })
  @ApiResponse({ status: 200, description: 'Block removed' })
  @ApiResponse({ status: 404, description: 'Block not found' })
  removeBlock(
    @Param('id', ParseIntPipe) id: number,
    @Param('blockId', ParseIntPipe) blockId: number,
    @CurrentUser() user: JwtPayload,
  ) {
    this.assertOwn(id, user);
    return this.doctors.removeBlock(id, blockId);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a doctor slot duration (15, 30 or 60 minutes)' })
  @ApiResponse({ status: 200, description: 'Slot duration updated' })
  setSlotDuration(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetSlotDurationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    this.assertOwn(id, user);
    return this.doctors.setSlotDuration(id, dto.slotDurationMin);
  }
}