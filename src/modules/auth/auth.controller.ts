import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthService, AuthTokens, LoginResult } from './auth.service';
import {
  MfaAuthenticateDto,
  MfaVerifyDto,
  RefreshTokenDto,
  SendOtpDto,
  VerifyOtpDto,
} from './dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/**
 * Auth HTTP surface — Phase 1 login core. Routes are mounted under the global
 * `/api/v1` prefix, so the effective paths are `/api/v1/auth/*`.
 */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  private setCookies(response: any, tokens: AuthTokens): void {
    const isProduction = process.env.NODE_ENV === 'production';
    response.cookie('nugenova_token', tokens.accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax',
      maxAge: tokens.expiresIn * 1000,
      path: '/',
    });
    response.cookie('nugenova_refresh', tokens.refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });
  }

  private clearCookies(response: any): void {
    const isProduction = process.env.NODE_ENV === 'production';
    const opts = {
      httpOnly: true,
      secure: isProduction,
      sameSite: (isProduction ? 'strict' : 'lax') as 'strict' | 'lax',
      maxAge: 0,
      path: '/',
    };
    response.cookie('nugenova_token', '', opts);
    response.cookie('nugenova_refresh', '', opts);
  }

  // ── OTP login ──────────────────────────────────────────────────────────────

  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  async sendOtp(
    @Body() body: SendOtpDto,
    @Req() req: any,
    @Res({ passthrough: true }) response: any,
  ) {
    const ipAddress = req.ip || req.connection?.remoteAddress;
    // Starting a fresh auth flow — clear any lingering session cookies.
    this.clearCookies(response);
    await this.authService.sendOtp(body.email, ipAddress);
    // Always return success to prevent user enumeration.
    return { success: true, message: 'OTP sent to your email' };
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  async verifyOtp(
    @Body() body: VerifyOtpDto,
    @Req() req: any,
    @Res({ passthrough: true }) response: any,
  ) {
    const ipAddress = req.ip || req.connection?.remoteAddress;
    const result = await this.authService.verifyOtp(
      body.email,
      body.otp,
      ipAddress,
    );

    if (result.mfaRequired) {
      return {
        success: true,
        message: 'Two-factor authentication required',
        data: {
          mfaRequired: true,
          mfaChallengeToken: result.mfaChallengeToken,
          email: result.user.email,
        },
      };
    }

    return this.finishLogin(result as LoginResult, response);
  }

  @Post('mfa/authenticate')
  @HttpCode(HttpStatus.OK)
  async authenticateMfa(
    @Body() body: MfaAuthenticateDto,
    @Req() req: any,
    @Res({ passthrough: true }) response: any,
  ) {
    const ipAddress = req.ip || req.connection?.remoteAddress;
    const result = await this.authService.authenticateMfa(
      body.mfaChallengeToken,
      body.code,
      ipAddress,
    );
    return this.finishLogin(result, response);
  }

  private finishLogin(result: LoginResult, response: any) {
    this.setCookies(response, result.tokens);
    return {
      success: true,
      message: 'OTP verified',
      data: {
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        user: {
          id: result.user.id,
          _id: result.user.id,
          email: result.user.email,
          firstName: result.user.firstName,
          lastName: result.user.lastName,
          setupStage: result.user.setupStage,
          organizations: result.user.organizations,
          isPlatformAdmin: result.user.isPlatformAdmin,
        },
        route: result.route.route,
        routeReason: result.route.reason,
        organizationId: result.route.organizationId,
        organizations: result.route.organizations || undefined,
        isNewUser: result.isNewUser,
      },
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() body: RefreshTokenDto,
    @Req() req: any,
    @Res({ passthrough: true }) response: any,
  ) {
    const refreshToken = body.refreshToken || req.cookies?.nugenova_refresh;
    const tokens = await this.authService.refreshToken(refreshToken);
    this.setCookies(response, tokens);
    return { success: true, data: tokens };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: any, @Res({ passthrough: true }) response: any) {
    await this.authService.logout(req.user.userId, {
      jti: req.user.jti,
      exp: req.user.exp,
      family: req.user.family,
    });
    this.clearCookies(response);
    return { success: true, message: 'Logged out' };
  }

  // ── Identity ───────────────────────────────────────────────────────────────

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getCurrentUser(@Req() req: any) {
    const user = await this.authService.getUserById(req.user.userId);
    return { success: true, data: this.authService.toPublicUser(user) };
  }

  @Get('check-email')
  async checkEmail(@Query('email') email: string) {
    const result = await this.authService.checkEmail(email);
    return { success: true, data: result };
  }

  // ── MFA enrolment ──────────────────────────────────────────────────────────

  @Post('mfa/setup')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async setupMFA(@Req() req: any) {
    const data = await this.authService.setupMFA(req.user.userId);
    return { success: true, data };
  }

  @Post('mfa/verify')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async verifyMFA(@Req() req: any, @Body() body: MfaVerifyDto) {
    const data = await this.authService.verifyMFA(req.user.userId, body.code);
    return { success: true, data };
  }

  @Delete('mfa')
  @UseGuards(JwtAuthGuard)
  async disableMFA(@Req() req: any) {
    await this.authService.disableMFA(req.user.userId);
    return { success: true, message: 'MFA disabled' };
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async getSessions(@Req() req: any) {
    const sessions = await this.authService.getSessions(req.user.userId);
    return { success: true, data: sessions };
  }

  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  async revokeSession(@Param('id') id: string, @Req() req: any) {
    await this.authService.revokeSession(req.user.userId, id);
    return { success: true, message: 'Session revoked' };
  }

  @Delete('sessions')
  @UseGuards(JwtAuthGuard)
  async revokeAllSessions(@Req() req: any) {
    await this.authService.revokeAllSessions(req.user.userId);
    return { success: true, message: 'All sessions revoked' };
  }
}
