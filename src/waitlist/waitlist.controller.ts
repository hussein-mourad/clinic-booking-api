import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.decorator';
import { JoinWaitlistDto } from './dto/join-waitlist.dto';
import { WaitlistService } from './waitlist.service';

@ApiTags('waitlist')
@ApiBearerAuth()
@Controller('waitlist')
@Roles('patient')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Post()
  join(@CurrentUser() user: JwtPayload, @Body() dto: JoinWaitlistDto) {
    return this.waitlist.join(user.sub, dto);
  }

  @Get('me')
  @ApiOperation({
    summary: "List the current patient's waiting-list entries with status",
  })
  @ApiResponse({ status: 200, description: 'Array of waiting-list entries' })
  mine(@CurrentUser() user: JwtPayload) {
    return this.waitlist.mine(user.sub);
  }

  @Post(':id/accept')
  accept(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.waitlist.accept(user.sub, id);
  }

  @Delete(':id')
  leave(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.waitlist.leave(user.sub, id);
  }
}
