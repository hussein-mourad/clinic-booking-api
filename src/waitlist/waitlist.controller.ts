import { Body, Controller, Delete, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.decorator';
import { JoinWaitlistDto } from './dto/join-waitlist.dto';
import { WaitlistService } from './waitlist.service';

@ApiTags('waitlist')
@Controller('waitlist')
@Roles('patient')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Post()
  join(@CurrentUser() user: JwtPayload, @Body() dto: JoinWaitlistDto) {
    return this.waitlist.join(user.sub, dto);
  }

  @Post(':id/accept')
  accept(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.waitlist.accept(user.sub, id);
  }

  @Delete(':id')
  leave(@CurrentUser() user: JwtPayload, @Param('id', ParseIntPipe) id: number) {
    return this.waitlist.leave(user.sub, id);
  }
}