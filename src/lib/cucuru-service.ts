import { drizzle } from "drizzle-orm/mysql2"
import { and, eq, sql } from "drizzle-orm"
import { pool } from "../db"
import { accountPool, sales, tenants } from "../db/schema"

export async function configurarWebhookTenant(
  apiKey: string,
  collectorId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = "https://api.cucuru.com/app/v1/Collection/webhooks/endpoint";
    const body = { url: "https://api.totem.uno/api/webhook/cucuru/collection_received" };

    const response = await fetch(url, {
      method: "POST",
      headers: {
          "Content-Type": "application/json",
          "X-Cucuru-Api-Key": apiKey,
          "X-Cucuru-Collector-id": collectorId
      },
      body: JSON.stringify(body)
  });


    if (!response.ok) {
      console.error("[cucuru] configurarWebhookTenant failed", response.status)
      return { ok: false, error: `http_${response.status}` }
    }

    return { ok: true }
  } catch (e) {
    console.error("[cucuru] configurarWebhookTenant exception", e)
    return {
      ok: false,
      error: e instanceof Error ? e.message : "unknown_error",
    }
  }
}

export type AsignarAliasResult =
  | { alias: string; accountNumber: string }
  | { ok: false; reason: string }
  
export async function asignarAliasASale(
  saleId: string,
  tenantId: string,
  slug: string
): Promise<AsignarAliasResult> {
  const db = drizzle(pool)

  try {
    const [tenant] = await db
      .select({
        cucuruApiKey: tenants.cucuruApiKey,
        cucuruCollectorId: tenants.cucuruCollectorId,
        cucuruEnabled: tenants.cucuruEnabled,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)

    const [sale] = await db
      .select({
        id: sales.id,
        tenantId: sales.tenantId,
        totalAmount: sales.totalAmount,
      })
      .from(sales)
      .where(and(eq(sales.id, saleId), eq(sales.tenantId, tenantId)))
      .limit(1)

    if (!tenant || !sale) {
      return { ok: false, reason: "tenant_or_sale_not_found" }
    }

    if (!tenant.cucuruEnabled) {
      return { ok: false, reason: "cucuru_disabled" }
    }

    
    const countQueryRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(accountPool)
    .where(eq(accountPool.tenantId, tenantId));
    const totalAccounts = countQueryRows[0].count ?? 0;

    const apiKey = tenant.cucuruApiKey?.trim()
    const collectorId = tenant.cucuruCollectorId?.trim()
    if (!apiKey || !collectorId) {
      return { ok: false, reason: "missing_credentials" }
    }

    
    let newAccountRes;

    try {
      const createCvuRequest = await fetch("https://api.cucuru.com/app/v1/Collection/accounts/account", {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
            "X-Cucuru-Api-Key": apiKey,
            "X-Cucuru-Collector-id": collectorId
        },
        body: JSON.stringify({
            customer_id: tenantId.toString()
        })
      });

      
      if (!createCvuRequest.ok) {
        const err = await createCvuRequest.text();
        throw new Error(`Error creando CVU: ${createCvuRequest.status} ${err}`);
      }

      newAccountRes = await createCvuRequest.json();
    } catch (error) {
      console.error("Error creando cuenta en Cucuru:", error);
      throw new Error("Fallo al crear cuenta CVU virtual en el proveedor.");
    }
    
    const accountNumber = newAccountRes.account_number.toString();
    // Construimos el alias con un formato secuencial: piru.[slug].[numero_secuencial]
    const aliasSecuencial = `totem.${slug}.${totalAccounts + 1}`.slice(0, 20);

      // 4. Asignar el Alias al nuevo CVU
      try {
        const createAliasRequest = await fetch("https://api.cucuru.com/app/v1/Collection/accounts/account/alias", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Cucuru-Api-Key": apiKey,
                "X-Cucuru-Collector-id": collectorId
            },
            body: JSON.stringify({
                account_number: accountNumber,
                alias: aliasSecuencial
            })
        });

        if (!createAliasRequest.ok) {
            const err = await createAliasRequest.text();
            throw new Error(`Error asignando Alias: ${createAliasRequest.status} ${err}`);
        }
    } catch (error) {
        console.error("Error asignando alias en Cucuru:", error);
        throw new Error("Fallo al asignar alias al nuevo CVU en el proveedor.");
    }

    await db.insert(accountPool).values({
      tenantId: tenantId,
      accountNumber: accountNumber,
      alias: aliasSecuencial,
      status: "available",
      saleIdAssigned: saleId,
    });

    return {
      alias: aliasSecuencial,
      accountNumber: accountNumber,
    }
  } catch (e) {
    console.error("[cucuru] asignarAliasASale exception", e)
    return { ok: false, reason: "exception" }
  }
}
