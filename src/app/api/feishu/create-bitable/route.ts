import { NextRequest, NextResponse } from 'next/server';
import { writeFeishuConfig } from '@/lib/feishu-config-store';
import { authorizeFeishuUser } from '@/lib/feishu-service';
import type { FeishuConfig } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      appId: string;
      appSecret: string;
      authMode?: 'tenant' | 'user';
      code?: string;
      redirectUri?: string;
      appToken?: string;
      tableId?: string;
      bitableUrl?: string;
      userAccessToken?: string;
      userRefreshToken?: string;
      userTokenExpiresAt?: number;
      userOpenId?: string;
      userName?: string;
      userGrantedScope?: string;
    };

    if (!body.appId || !body.appSecret) {
      return NextResponse.json({ error: '请先填写 App ID 和 App Secret' }, { status: 400 });
    }

    if (body.authMode === 'user') {
      if (!body.code || !body.redirectUri) {
        return NextResponse.json({ error: '缺少飞书授权回调参数' }, { status: 400 });
      }

      const config = await authorizeFeishuUser({
        appId: body.appId,
        appSecret: body.appSecret,
        code: body.code,
        redirectUri: body.redirectUri,
        existingConfig: {
          appToken: body.appToken,
          tableId: body.tableId,
          bitableUrl: body.bitableUrl,
        },
      });

      await writeFeishuConfig(config);

      return NextResponse.json({
        success: true,
        authMode: config.authMode,
        appToken: config.appToken,
        tableId: config.tableId,
        bitableUrl: config.bitableUrl,
        userAccessToken: config.userAccessToken,
        userRefreshToken: config.userRefreshToken,
        userTokenExpiresAt: config.userTokenExpiresAt,
        userOpenId: config.userOpenId,
        userName: config.userName,
        userGrantedScope: config.userGrantedScope,
      });
    }

    const config: FeishuConfig = {
      appId: body.appId,
      appSecret: body.appSecret,
      appToken: body.appToken || '',
      tableId: body.tableId || '',
      authMode: 'tenant',
      bitableUrl: body.bitableUrl || '',
    };

    await writeFeishuConfig(config);

    return NextResponse.json({
      success: true,
      authMode: config.authMode,
      appToken: config.appToken,
      tableId: config.tableId,
      bitableUrl: config.bitableUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '飞书授权失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
