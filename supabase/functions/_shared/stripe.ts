// Formula Home — shared helpers for the Stripe payment functions.
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2";

export const SITE = Deno.env.get("SITE_URL") ?? "https://formula-home.com";

export const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
});

// Service-role client: bypasses RLS, only used server-side.
export const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// Fee charged to the guest on top of the stay (0 = none for now).
export const SERVICE_FEE_RATE = 0;

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const ZERO_DECIMAL = new Set(["bif","clp","djf","gnf","jpy","kmf","krw","mga","pyg","rwf","ugx","vnd","vuv","xaf","xof","xpf"]);
export function toMinor(amount: number, currency: string) {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? Math.round(amount) : Math.round(amount * 100);
}

// Free-text country (as typed by hosts) -> ISO code for Stripe.
const COUNTRIES: Record<string, string> = {
  argentina: "AR", brasil: "BR", brazil: "BR", mexico: "MX", "méxico": "MX",
  chile: "CL", uruguay: "UY", paraguay: "PY", colombia: "CO", peru: "PE", "perú": "PE",
  "estados unidos": "US", usa: "US", "united states": "US", eeuu: "US", canada: "CA", "canadá": "CA",
  "españa": "ES", spain: "ES", italia: "IT", italy: "IT", francia: "FR", france: "FR",
  alemania: "DE", germany: "DE", "reino unido": "GB", "united kingdom": "GB", uk: "GB",
  "países bajos": "NL", "paises bajos": "NL", netherlands: "NL", "holanda": "NL", belgica: "BE", "bélgica": "BE", belgium: "BE",
  austria: "AT", hungria: "HU", "hungría": "HU", hungary: "HU", monaco: "MC", "mónaco": "MC",
  portugal: "PT", suiza: "CH", switzerland: "CH", japon: "JP", "japón": "JP", japan: "JP",
  australia: "AU", singapur: "SG", singapore: "SG", china: "CN", "emiratos árabes unidos": "AE", uae: "AE",
  "arabia saudita": "SA", "saudi arabia": "SA", qatar: "QA", catar: "QA", bahrein: "BH", "baréin": "BH", bahrain: "BH",
  azerbaiyan: "AZ", "azerbaiyán": "AZ", azerbaijan: "AZ",
};
export function countryCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(k)) return k.toUpperCase();
  return COUNTRIES[k] ?? null;
}

// Authenticated caller from the Authorization header.
export async function callerFrom(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data?.user ?? null;
}

// Marks a booking as paid once Stripe confirms the Checkout Session.
export async function settleSession(bookingId: string, sessionId: string) {
  const s = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["payment_intent"] });
  if (s.payment_status !== "paid") {
    if (s.status === "expired") {
      await admin.from("bookings").update({ payment_status: "unpaid", stripe_session_id: null })
        .eq("id", bookingId).eq("payment_status", "pending");
    }
    return false;
  }
  const pi = s.payment_intent as Stripe.PaymentIntent | null;
  await admin.from("bookings").update({
    payment_status: "paid",
    paid_at: new Date().toISOString(),
    stripe_payment_intent: pi?.id ?? null,
    stripe_charge_id: (pi?.latest_charge as string) ?? null,
    payout_status: "pending",
    updated_at: new Date().toISOString(),
  }).eq("id", bookingId).neq("payment_status", "paid");
  return true;
}
