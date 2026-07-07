"""Generate the bundled sample PDFs (a lease and a terms of service).

Run from backend/:  .venv/bin/python scripts/make_samples.py
Output: backend/samples/*.pdf

Both documents are fictional but deliberately realistic - including the
gotchas people actually ask about (late fees, auto-renewal, cancellation
windows, deposits) so the demo questions have real answers with receipts.
"""

from pathlib import Path

from fpdf import FPDF

SAMPLES_DIR = Path(__file__).resolve().parent.parent / "samples"

Section = tuple[str, list[str]]


def build_pdf(title: str, subtitle: str, sections: list[Section], out_path: Path) -> None:
    pdf = FPDF(format="letter")
    pdf.set_auto_page_break(auto=True, margin=22)
    pdf.set_margins(20, 20, 20)
    pdf.add_page()

    def cell(height: float, text: str) -> None:
        pdf.multi_cell(0, height, text, new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("helvetica", "B", 18)
    cell(9, title)
    pdf.set_font("helvetica", "I", 11)
    cell(6, subtitle)
    pdf.ln(4)

    for heading, paragraphs in sections:
        pdf.set_font("helvetica", "B", 12)
        cell(7, heading)
        pdf.set_font("helvetica", "", 10.5)
        for para in paragraphs:
            cell(5.5, para)
            pdf.ln(1.5)
        pdf.ln(2)

    pdf.output(str(out_path))
    print(f"wrote {out_path}")


LEASE_SECTIONS: list[Section] = [
    ("1. Parties and Premises", [
        "This Residential Lease Agreement (the \"Lease\") is entered into on "
        "March 1, 2026 between Maplewood Property Management LLC (\"Landlord\") "
        "and Jordan Rivera (\"Tenant\"). The Landlord leases to the Tenant the "
        "residential unit located at 482 Alder Street, Apartment 3B, "
        "Springfield (the \"Premises\"), for use as a private residence only.",
    ]),
    ("2. Term", [
        "The initial term of this Lease begins on April 1, 2026 and ends on "
        "March 31, 2027. If the Tenant remains in possession after the end of "
        "the term with the Landlord's consent, this Lease converts to a "
        "month-to-month tenancy on the same terms, except that either party "
        "may terminate the month-to-month tenancy with thirty (30) days "
        "written notice.",
    ]),
    ("3. Rent", [
        "Monthly rent is $1,850, due on the first (1st) day of each calendar "
        "month, payable by bank transfer or check to the Landlord's office at "
        "12 Commerce Way, Suite 200.",
        "If rent is not received by the fifth (5th) day of the month, the "
        "Tenant shall pay a late fee of $75, plus $10 for each additional day "
        "the rent remains unpaid, up to a maximum total late charge of $250 "
        "per month. A returned or bounced payment incurs a separate $35 fee.",
    ]),
    ("4. Security Deposit", [
        "On signing this Lease, the Tenant shall pay a security deposit of "
        "$2,775 (one and one-half months' rent). The deposit may not be "
        "applied by the Tenant to the last month's rent.",
        "Within twenty-one (21) days after the Tenant vacates, the Landlord "
        "shall return the deposit less lawful deductions, with an itemized "
        "written statement of any amounts withheld. Deductions may be made "
        "for unpaid rent, damage beyond ordinary wear and tear, and cleaning "
        "required to return the Premises to its move-in condition.",
    ]),
    ("5. Utilities", [
        "The Landlord pays for water, sewer, and trash collection. The Tenant "
        "is responsible for electricity, gas, internet, and any other "
        "services, and must keep utility accounts in the Tenant's own name "
        "for the full term.",
    ]),
    ("6. Occupancy and Guests", [
        "The Premises may be occupied only by the Tenant and the occupants "
        "listed on the application. A guest staying more than fourteen (14) "
        "consecutive days, or more than twenty-one (21) total days in any six "
        "month period, requires the Landlord's prior written consent.",
    ]),
    ("7. Pets", [
        "No pets are permitted without the Landlord's prior written consent. "
        "If consent is given, the Tenant shall pay a one-time non-refundable "
        "pet fee of $300 and additional pet rent of $40 per month per pet. "
        "Registered assistance animals are not pets, and no fee or pet rent "
        "applies to them.",
    ]),
    ("8. Maintenance and Repairs", [
        "The Tenant must keep the Premises clean and promptly report any "
        "condition that could cause damage, including leaks and pest "
        "activity. The Landlord is responsible for repairs to plumbing, "
        "heating, electrical systems, and appliances supplied with the unit, "
        "except where damage is caused by the Tenant's misuse or neglect, in "
        "which case the repair cost is billed to the Tenant.",
        "Non-emergency repair requests must be submitted in writing through "
        "the resident portal. The Landlord shall begin addressing urgent "
        "habitability issues (no heat, no water, major leaks) within "
        "twenty-four (24) hours of notice.",
    ]),
    ("9. Alterations", [
        "The Tenant may hang pictures using standard picture hooks. Painting, "
        "wallpapering, mounting televisions to walls, and installing shelving "
        "or fixtures require the Landlord's prior written consent. Approved "
        "alterations become the Landlord's property unless the Landlord "
        "requires their removal and restoration at move-out.",
    ]),
    ("10. Landlord's Right of Entry", [
        "Except in emergencies, the Landlord shall give the Tenant at least "
        "twenty-four (24) hours written notice before entering, and entry "
        "shall occur only on weekdays between 9:00 a.m. and 6:00 p.m. for "
        "inspections, repairs, or showings. In an emergency threatening life "
        "or property, the Landlord may enter without notice.",
    ]),
    ("11. Subletting and Assignment", [
        "The Tenant shall not sublet the Premises, assign this Lease, or list "
        "the Premises on any short-term rental platform (including Airbnb "
        "and similar services) without the Landlord's prior written consent. "
        "Any unauthorized subletting is a material breach of this Lease.",
    ]),
    ("12. Early Termination", [
        "If the Tenant needs to end the Lease before March 31, 2027, the "
        "Tenant must give at least sixty (60) days written notice and pay an "
        "early termination fee equal to two (2) months' rent ($3,700). The "
        "fee is waived for active-duty military transfer orders as provided "
        "by law.",
    ]),
    ("13. Renewal and Rent Increases", [
        "The Landlord shall offer any renewal, with the new rent amount, at "
        "least sixty (60) days before the end of the term. Rent shall not "
        "increase during the initial term. For month-to-month tenancies, the "
        "Landlord may change the rent with thirty (30) days written notice.",
    ]),
    ("14. Insurance", [
        "The Landlord's insurance does not cover the Tenant's personal "
        "belongings. The Tenant is required to maintain renter's insurance "
        "with at least $100,000 of personal liability coverage for the full "
        "term and to name the Landlord as an interested party on the policy.",
    ]),
    ("15. Notices", [
        "Written notices under this Lease may be delivered by hand, by mail "
        "to the addresses above, or through the resident portal. Notice is "
        "effective on delivery, or three (3) days after mailing.",
    ]),
]

TOS_SECTIONS: list[Section] = [
    ("1. Who We Are", [
        "These Terms of Service (the \"Terms\") govern your use of Lumen "
        "Notes, a note-taking and sync service operated by Lumen Software "
        "Inc. (\"Lumen\", \"we\", \"us\"). By creating an account or using the "
        "service you agree to these Terms.",
    ]),
    ("2. Your Account", [
        "You must be at least 13 years old to use Lumen Notes. You are "
        "responsible for keeping your password secure and for all activity "
        "under your account. Notify us immediately at security@lumen.example "
        "if you suspect unauthorized access.",
    ]),
    ("3. Plans and Billing", [
        "The Free plan includes up to 500 notes and 100 MB of attachments. "
        "The Premium plan costs $8 per month, or $80 per year (two months "
        "free), plus applicable taxes.",
        "Premium subscriptions renew automatically at the end of each billing "
        "period. We charge the payment method on file on the first day of "
        "each new period. If a charge fails, we retry for up to seven (7) "
        "days and then downgrade the account to the Free plan.",
        "We may change subscription prices with at least thirty (30) days "
        "notice by email. Price changes take effect at your next renewal, "
        "never mid-period.",
    ]),
    ("4. Cancellation and Refunds", [
        "You can cancel your Premium subscription at any time in Settings > "
        "Billing > Cancel Subscription, or by emailing "
        "support@lumen.example from your account email address. Cancellation "
        "takes effect at the end of the current billing period, and you keep "
        "Premium features until then.",
        "Monthly plans are not refundable. Annual plans may be refunded on a "
        "pro-rated basis within the first sixty (60) days of the annual "
        "period; after sixty days, annual fees are non-refundable. Refunds "
        "required by consumer protection law are always honored.",
    ]),
    ("5. Your Content", [
        "You own the notes, files, and other content you store in Lumen "
        "Notes. You grant us a limited license to host, back up, transmit, "
        "and display your content solely to operate and improve the service. "
        "We do not sell your content and we do not use the contents of your "
        "notes to train advertising profiles.",
    ]),
    ("6. Privacy and Data", [
        "Note contents are encrypted in transit and at rest. Our staff may "
        "access note contents only with your explicit permission during a "
        "support case, or where required by law.",
        "If your account is inactive for twenty-four (24) consecutive months "
        "we will email you twice before deleting the account and its "
        "contents. After account deletion, residual copies are removed from "
        "backups within ninety (90) days.",
    ]),
    ("7. Acceptable Use", [
        "You may not use Lumen Notes to store or distribute malware, to "
        "infringe others' intellectual property, to harass others, or to "
        "violate the law. We may suspend accounts that violate this section, "
        "and we will notify you by email when we do unless the law prevents "
        "notification.",
    ]),
    ("8. Service Changes and Termination", [
        "We may add, change, or remove features at any time. If we "
        "discontinue Lumen Notes entirely, we will give at least ninety (90) "
        "days notice and provide a tool to export all of your notes.",
        "You may delete your account at any time in Settings > Account > "
        "Delete Account, which permanently deletes your content. We may "
        "terminate accounts that materially breach these Terms; where "
        "practical we will give fourteen (14) days notice and an "
        "opportunity to export your content.",
    ]),
    ("9. Disclaimers", [
        "Lumen Notes is provided \"as is\". To the maximum extent permitted "
        "by law we disclaim warranties of merchantability, fitness for a "
        "particular purpose, and non-infringement. We do not warrant that "
        "the service will be uninterrupted or error-free.",
    ]),
    ("10. Limitation of Liability", [
        "To the maximum extent permitted by law, Lumen's total liability for "
        "all claims relating to the service in any twelve (12) month period "
        "is limited to the greater of $100 or the amount you paid us in that "
        "period. We are not liable for indirect, incidental, or "
        "consequential damages, including lost profits or lost data, except "
        "where such limits are not permitted by law.",
    ]),
    ("11. Disputes and Arbitration", [
        "Before filing any claim, you agree to contact us at "
        "legal@lumen.example and give us thirty (30) days to try to resolve "
        "the dispute informally.",
        "Any dispute not resolved informally shall be settled by binding "
        "individual arbitration administered by the National Arbitration "
        "Forum under its consumer rules, and you waive the right to "
        "participate in a class action. You may opt out of this arbitration "
        "clause by emailing legal@lumen.example within thirty (30) days of "
        "first accepting these Terms. Small claims court remains available "
        "for qualifying disputes.",
    ]),
    ("12. Changes to These Terms", [
        "We may update these Terms. For material changes we will give at "
        "least thirty (30) days notice by email and in-app banner. If you "
        "continue using the service after changes take effect, you accept "
        "the new Terms; if you do not agree, your remedy is to stop using "
        "the service and delete your account.",
    ]),
]


def main() -> None:
    SAMPLES_DIR.mkdir(exist_ok=True)
    build_pdf(
        "Residential Lease Agreement",
        "482 Alder Street, Apartment 3B - Sample document for demo purposes. "
        "This is a fictional lease.",
        LEASE_SECTIONS,
        SAMPLES_DIR / "sample-apartment-lease.pdf",
    )
    build_pdf(
        "Lumen Notes - Terms of Service",
        "Effective January 15, 2026 - Sample document for demo purposes. "
        "This is a fictional terms of service.",
        TOS_SECTIONS,
        SAMPLES_DIR / "sample-terms-of-service.pdf",
    )


if __name__ == "__main__":
    main()
