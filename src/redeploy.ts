interface VersionsResponse {
  result?: { current?: { version_id?: string } };
}

interface DeploymentResponse {
  success?: boolean;
  errors?: Array<{ message?: string }>;
}

/**
 * 通过 Cloudflare 控制台的 artifacts 端点触发一次「同代码重新部署」。
 * 用途：secret 更新在旧实例上偶发不生效时，一键让新配置生效，无需本地 wrangler。
 * 需要 CF_API_TOKEN（令牌权限：Account → Cloudflare Pages/Workers Scripts → Edit）与 CF_ACCOUNT_ID。
 */
export async function redeploySelf(
  apiToken: string,
  accountId: string,
  scriptName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; message: string }> {
  if (!apiToken || !accountId) {
    return {
      ok: false,
      status: 503,
      message:
        "未配置 CF_API_TOKEN / CF_ACCOUNT_ID，无法从看板触发重新部署。请改用：wrangler secret put AMD_ACCOUNTS && npx wrangler deploy",
    };
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`;
  const headers = { authorization: `Bearer ${apiToken}` };

  let versionId: string | undefined;
  try {
    const verRes = await fetchImpl(`${base}/versions`, { headers });
    const verJson = (await verRes.json().catch(() => ({}))) as VersionsResponse;
    if (!verRes.ok) {
      return { ok: false, status: verRes.status, message: `读取版本失败：${verRes.status}` };
    }
    versionId = verJson.result?.current?.version_id;
  } catch (err) {
    return { ok: false, status: 502, message: `Cloudflare API 不可达：${String(err)}` };
  }

  if (!versionId) {
    return { ok: false, status: 409, message: "读不到当前 deployment version_id" };
  }

  try {
    const depRes = await fetchImpl(`${base}/deployments`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        deployment_id: crypto.randomUUID(),
        versions: [{ version_id: versionId, percentage: 100 }],
      }),
    });
    const json = (await depRes.json().catch(() => ({}))) as DeploymentResponse;
    if (!depRes.ok || json.success === false) {
      const msg = json.errors?.[0]?.message ?? `HTTP ${depRes.status}`;
      return {
        ok: false,
        status: depRes.status,
        message: `触发失败：${msg}。请确认令牌具备 Workers Scripts Edit 权限，或手动执行 npx wrangler deploy`,
      };
    }
    return { ok: true, status: 200, message: "已触发重新部署，约 10 秒后生效" };
  } catch (err) {
    return { ok: false, status: 502, message: `触发部署失败：${String(err)}` };
  }
}
