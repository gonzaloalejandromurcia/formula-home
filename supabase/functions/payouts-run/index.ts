// Formula Home — scheduled job (hourly via pg_cron). Idempotent; takes no input.
//  1. Confirms payments left "pending" (guest closed the tab after paying).
//  2. Pays hosts 1 day after check-in (transfer to their Stripe Connect account).
//  3. Refunds paid bookings that were cancelled before the host was paid.
import { admin, CORS, json, settleSession, stripe } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const out = { confirmed: 0, paid_out: 0, waiting_host_account: 0, refunded: 0, errors: [] as string[] };

  // 1. reconcile pending payments
  const { data: pend } = await admin.from("bookings")
    .select("id, stripe_session_id").eq("payment_status", "pending").not("stripe_session_id", "is", null).limit(50);
  for (const b of pend ?? []) {
    try { if (await settleSession(b.id, b.stripe_session_id)) out.confirmed++; }
    catch (e) { out.errors.push(`confirm ${b.id}: ${(e as Error).message}`); }
  }

  // 2. host payouts, 1 day after check-in
  const cutoff = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const { data: due } = await admin.from("bookings")
    .select("id, host_id, amount_due, host_payout, stripe_charge_id, stripe_payment_intent")
    .eq("status", "accepted").eq("payment_status", "paid").eq("payout_status", "pending")
    .lte("check_in", cutoff).limit(50);
  for (const b of due ?? []) {
    try {
      const { data: hp } = await admin.from("host_private")
        .select("stripe_account_id, stripe_payouts_enabled").eq("host_id", b.host_id).maybeSingle();
      if (!hp?.stripe_account_id || !hp.stripe_payouts_enabled) { out.waiting_host_account++; continue; }
      let chargeId = b.stripe_charge_id as string | null;
      if (!chargeId && b.stripe_payment_intent) {
        const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent);
        chargeId = (pi.latest_charge as string) ?? null;
      }
      if (!chargeId) throw new Error("no charge");
      // Transfer in the platform's settlement currency, proportional to the host's share.
      const ch = await stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] });
      const bt = ch.balance_transaction as { amount: number; currency: string };
      const share = Number(b.host_payout) / Number(b.amount_due);
      const amount = Math.floor(bt.amount * share);
      const tr = await stripe.transfers.create({
        amount, currency: bt.currency, destination: hp.stripe_account_id,
        source_transaction: chargeId, transfer_group: b.id, metadata: { booking_id: b.id },
      }, { idempotencyKey: `payout-${b.id}` });
      await admin.from("bookings").update({
        payout_status: "paid", stripe_transfer_id: tr.id, stripe_charge_id: chargeId,
        payout_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", b.id);
      out.paid_out++;
    } catch (e) {
      out.errors.push(`payout ${b.id}: ${(e as Error).message}`);
    }
  }

  // 3. refunds for cancelled paid bookings (full refund until a cancellation policy is defined)
  const { data: canc } = await admin.from("bookings")
    .select("id, stripe_payment_intent").eq("status", "cancelled").eq("payment_status", "paid")
    .neq("payout_status", "paid").limit(50);
  for (const b of canc ?? []) {
    try {
      if (!b.stripe_payment_intent) throw new Error("no payment intent");
      const r = await stripe.refunds.create({ payment_intent: b.stripe_payment_intent, metadata: { booking_id: b.id } },
        { idempotencyKey: `refund-${b.id}` });
      await admin.from("bookings").update({
        payment_status: "refunded", payout_status: "cancelled", stripe_refund_id: r.id, updated_at: new Date().toISOString(),
      }).eq("id", b.id);
      out.refunded++;
    } catch (e) {
      out.errors.push(`refund ${b.id}: ${(e as Error).message}`);
    }
  }

  return json(out);
});
