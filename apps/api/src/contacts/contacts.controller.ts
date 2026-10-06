import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { User } from "@prisma/client";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ContactsService } from "./contacts.service";
import { AddContactDto, ContactUserDto, InviteDto, LookupDto, SyncContactsDto } from "./dto";

@Controller("contacts")
@UseGuards(JwtAuthGuard)
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.contacts.list(user);
  }

  @Post("lookup")
  lookup(@CurrentUser() user: User, @Body() body: LookupDto) {
    return this.contacts.lookup(user, body.phone, body.country);
  }

  @Post("sync")
  sync(@CurrentUser() user: User, @Body() body: SyncContactsDto) {
    return this.contacts.sync(user, body.contacts);
  }

  @Post("invite")
  invite(@CurrentUser() user: User, @Body() body: InviteDto) {
    return this.contacts.invite(user, body.phone, body.displayName, body.country);
  }

  @Post("add")
  add(@CurrentUser() user: User, @Body() body: AddContactDto) {
    return this.contacts.add(user, body.phone);
  }

  @Post("accept")
  accept(@CurrentUser() user: User, @Body() body: ContactUserDto) {
    return this.contacts.accept(user, body.userId);
  }

  @Post("block")
  block(@CurrentUser() user: User, @Body() body: ContactUserDto) {
    return this.contacts.block(user, body.userId);
  }
}
