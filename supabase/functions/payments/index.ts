// Formula Home — payments API (called from the site with the user's session).
// Actions:
//   onboard         host: create/continue Stripe Connect Express onboarding → { url }
//   account_status  host: refresh payout readiness → { has_account, payouts_enabled }
//   checkout        guest: create Stripe Checkout for an accepted booking → { url }
//   confirm         guest: confirm payment after returning from Checkout → { paid }
import { admin, callerFrom, countryCode, CORS, json, SERVICE_FEE_RATE, settleSession, SITE, stripe, toMinor } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const user = await callerFrom(req);
    if (!user) return json({ error: "not_authenticated" }, 401);
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "onboard": return await onboard(user);
      case "account_status": return await accountStatus(user);
      case "checkout": return await checkout(user, body.booking_id);
      case "confirm": return await confirm(user, body.booking_id);
      default: return json({ error: "bad_action" }, 400);
    }
  } catch (e) {
    console.error(e);
    const msg = (e as { message?: string })?.message ?? String(e);
    return json({ error: msg }, 400);
  }
});

async function ownerRows(userId: string) {
  const { data } = await admin.from("hosts")
    .select("id, country, host_private(stripe_account_id, stripe_payouts_enabled)")
    .eq("owner_id", userId).order("created_at");
  return (data ?? []).map((h: any) => ({ id: h.id, country: h.country, p: Array.isArray(h.host_private) ? h.host_private[0] : h.host_private }));
}

async function saveAccount(userId: string, patch: Record<string, unknown>) {
  const rows = await ownerRows(userId);
  for (const r of rows) {
    await admin.from("host_private").upsert({ host_id: r.id, ...patch }, { onConflict: "host_id" });
  }
}

async function onboard(user: { id: string; email?: string }) {
  const rows = await ownerRows(user.id);
  if (!rows.length) return json({ error: "no_listing" }, 400);
  let acct = rows.find((r) => r.p?.stripe_account_id)?.p?.stripe_account_id as string | undefined;
  if (!acct) {
    const country = countryCode(rows[0].country);
    if (!country) return json({ error: "unknown_country" }, 400);
    const a = await stripe.accounts.create({
      type: "express",
      country,
      email: user.email,
      capabilities: { transfers: { requested: true } },
      metadata: { fh_user: user.id },
    });
    acct = a.id;
    await saveAccount(user.id, { stripe_account_id: acct });
  }
  const link = await stripe.accountLinks.create({
    account: acct,
    type: "account_onboarding",
    refresh_url: `${SITE}/host-dashboard.html?stripe=refresh`,
    return_url: `${SITE}/host-dashboard.html?stripe=done`,
  });
  return json({ url: link.url });
}

async function accountStatus(user: { id: string }) {
  const rows = await ownerRows(user.id);
  const acct = rows.find((r) => r.p?.stripe_account_id)?.p?.stripe_account_id as string | undefined;
  if (!acct) return json({ has_account: false, payouts_enabled: false });
  const a = await stripe.accounts.retrieve(acct);
  const ready = a.capabilities?.transfers === "active" && !!a.details_submitted;
  await saveAccount(user.id, { stripe_payouts_enabled: ready });
  return json({ has_account: true, payouts_enabled: ready });
}

async function loadGuestBooking(userId: string, bookingId: string) {
  if (!bookingId) throw new Error("not_found");
  const { data: b } = await admin.from("bookings")
    .select("*, hosts(title, city, circuit)").eq("id", bookingId).maybeSingle();
  if (!b) throw new Error("not_found");
  if (b.guest_id !== userId) throw new Error("forbidden");
  return b;
}

async function checkout(user: { id: string; email?: string }, bookingId: string) {
  const b = await loadGuestBooking(user.id, bookingId);
  if (b.status !== "accepted") throw new Error("not_accepted");
  if (b.payment_status === "paid") throw new Error("already_paid");
  if (b.pay_by && new Date(b.pay_by) < new Date()) throw new Error("pay_expired");

  // Reuse an open session if the guest clicks twice.
  if (b.payment_status === "pending" && b.stripe_session_id) {
    const s = await stripe.checkout.sessions.retrieve(b.stripe_session_id);
    if (s.status === "open" && s.url) return json({ url: s.url });
    if (s.payment_status === "paid") { await settleSession(b.id, s.id); throw new Error("already_paid"); }
  }

  const { data: hp } = await admin.from("host_private").select("commission_rate").eq("host_id", b.host_id).maybeSingle();
  const rate = Number(hp?.commission_rate ?? 0.12);
  const stay = Number(b.total);
  const serviceFee = Math.round(stay * SERVICE_FEE_RATE * 100) / 100;
  const amountDue = stay + serviceFee;
  const platformFee = Math.round((stay * rate + serviceFee) * 100) / 100;
  const hostPayout = Math.round((amountDue - platformFee) * 100) / 100;
  const cur = String(b.currency || "USD").toLowerCase();
  const h = b.hosts ?? {};
  const name = `${h.title || h.city || "Formula Home stay"} · ${b.check_in} → ${b.check_out}`;

  const line_items: any[] = [{
    quantity: 1,
    price_data: { currency: cur, unit_amount: toMinor(stay, cur), product_data: { name, description: `${b.nights} night(s) · ${b.guests} guest(s)` } },
  }];
  if (serviceFee > 0) {
    line_items.push({ quantity: 1, price_data: { currency: cur, unit_amount: toMinor(serviceFee, cur), product_data: { name: "Formula Home service fee" } } });
  }

  const s = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items,
    customer_email: user.email,
    client_reference_id: b.id,
    metadata: { booking_id: b.id },
    payment_intent_data: { transfer_group: b.id, metadata: { booking_id: b.id } },
    success_url: `${SITE}/account.html?paid=${b.id}&session_id={CHECKOUT_SESSION_ID}#trips`,
    cancel_url: `${SITE}/account.html#trips`,
  });

  await admin.from("bookings").update({
    payment_status: "pending",
    stripe_session_id: s.id,
    service_fee: serviceFee,
    amount_due: amountDue,
    platform_fee: platformFee,
    host_payout: hostPayout,
    updated_at: new Date().toISOString(),
  }).eq("id", b.id);

  return json({ url: s.url });
}

async function confirm(user: { id: string }, bookingId: string) {
  const b = await loadGuestBooking(user.id, bookingId);
  if (b.payment_status === "paid") return json({ paid: true });
  if (!b.stripe_session_id) return json({ paid: false });
  const paid = await settleSession(b.id, b.stripe_session_id);
  return json({ paid });
}
