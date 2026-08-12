import { Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import fastifyCookie from '@fastify/cookie';
import { config } from '../../config';
import { AuthController } from './auth.controller';
import { MeController } from './me.controller';
import { DiscordOAuthService } from './discordOAuth.service';
import { SessionAccessService } from './sessionAccess.service';
import { SessionGuard } from './session.guard';
import { GuildAccessGuard } from './guildAccess.guard';

@Module({
    controllers: [AuthController, MeController],
    providers: [DiscordOAuthService, SessionAccessService, SessionGuard, GuildAccessGuard],
    exports: [SessionAccessService, SessionGuard, GuildAccessGuard],
})
export class AuthModule implements OnModuleInit {
    constructor(private readonly adapterHost: HttpAdapterHost) {}

    async onModuleInit() {
        const fastifyInstance = this.adapterHost.httpAdapter.getInstance();
        // The session/oauth-state cookies carry an opaque, random, unguessable
        // value looked up against Redis — not signed today. `secret` is wired
        // so a future signed cookie (e.g. a CSRF token readable by JS) can be
        // added without touching plugin registration again.
        await fastifyInstance.register(fastifyCookie, {
            secret: config.discordOAuth.sessionCookieSecret,
        });
    }
}
