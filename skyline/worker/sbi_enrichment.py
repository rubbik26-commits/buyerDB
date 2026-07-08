import datetime

from shared.normalize import norm_entity, is_placeholder

AMOUNT_TOL = 0.03
NO_PRICE_DATE_WINDOW_DAYS = 60


def amount_gate(sale_price, sale_date, deed_amount, deed_date):
    amount = float(deed_amount or 0)
    if sale_price is not None and float(sale_price) > 0:
        return amount > 0 and abs(amount - float(sale_price)) / float(sale_price) <= AMOUNT_TOL
    if not deed_date or not sale_date:
        return False
    try:
        sd = datetime.date.fromisoformat(str(sale_date)[:10])
        dd = datetime.date.fromisoformat(str(deed_date)[:10])
    except ValueError:
        return False
    return abs((sd - dd).days) <= NO_PRICE_DATE_WINDOW_DAYS


def get_or_create_entity(conn, display_name):
    nn = norm_entity(display_name)
    if not nn:
        return None
    with conn.cursor() as cur:
        cur.execute("select entity_id from sbi_entities where norm_name=%s", (nn,))
        row = cur.fetchone()
        if row:
            return row[0]
        cur.execute(
            "insert into sbi_entities (display_name, entity_type) values (%s,%s) returning entity_id",
            (str(display_name).strip(), "llc" if "LLC" in nn else ("corp" if "INC" in nn or "CORP" in nn else "unknown")),
        )
        return cur.fetchone()[0]


def apply_acris_party_fill(conn, deal_id, doc_id, deed_amount, deed_date, buyer=None, seller=None, buyer_address=None, seller_address=None):
    with conn.cursor() as cur:
        cur.execute("select sale_price, sale_date, notes from sbi_deals where deal_id=%s", (deal_id,))
        row = cur.fetchone()
        if not row:
            return {"status": "no_such_deal"}
        sale_price, sale_date, _notes = row
        if not amount_gate(sale_price, sale_date, deed_amount, deed_date):
            return {"status": "gated_out"}
        filled = []
        for role, name, mailing in (("buyer", buyer, buyer_address), ("seller", seller, seller_address)):
            if not name or is_placeholder(name):
                continue
            entity_id = get_or_create_entity(conn, name)
            if not entity_id:
                continue
            cur.execute(
                """
                insert into sbi_deal_parties
                  (deal_id, entity_id, role, mailing_address, source_system, provenance_ref, amount_gate_passed, verified_deed_amount)
                values (%s,%s,%s,%s,'acris',%s,true,%s)
                on conflict do nothing
                """,
                (deal_id, entity_id, role, mailing, doc_id, deed_amount),
            )
            if cur.rowcount:
                filled.append(role)
        if sale_price is None and float(deed_amount or 0) > 0:
            cur.execute("update sbi_deals set sale_price=%s, updated_at=now() where deal_id=%s and sale_price is null", (float(deed_amount), deal_id))
            if cur.rowcount:
                filled.append("sale_price")
        if filled:
            cur.execute("update sbi_deals set notes=trim(both ' |' from coalesce(notes,'') || %s), updated_at=now() where deal_id=%s", (f" | parties from ACRIS {doc_id} (amount-gated)", deal_id))
    return {"status": "filled" if filled else "nothing_to_fill", "filled": filled}
