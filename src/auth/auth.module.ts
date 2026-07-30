import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ApiKeyGuard } from './api-key.guard';

@Global()
@Module({
  providers: [AuthService, ApiKeyGuard],
  exports: [AuthService, ApiKeyGuard],
})
export class AuthModule {}
