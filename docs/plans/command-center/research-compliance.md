# Research: Compliance and Admin Obligations (2026-11-02)

Web research for `README.md` §6. Many sources are vendor/practitioner sites; **[VERIFY]** marks items that depend on AAC's entity setup or conflicting sources.

**Entity facts that change the answers:** (A) formation state: Connecticut Sealers LLC formed in CT and foreign-registered in MA, or formed in MA? (B) tax classification: multi-member partnership (1065 + K-1s + MA Form 3), single-member, or S-corp election? (C) DBA certificate for "Attack A Crack" on file?

## 1. Master obligation table

### Entity and registrations
| Obligation | Filed with | Cadence / due rule | Evidence | How it bites |
|---|---|---|---|---|
| MA annual report | MA Secretary of the Commonwealth | Annual, on anniversary of formation/foreign registration; \$500 (+\$20 online fee per some sources) [src](https://businessanywhere.io/massachusetts-llc-annual-report/) | Filed report; Certificate of Good Standing | No late fee, but administrative dissolution after ~2 years; lost good standing blocks bids and bank actions [src](https://www.statebusinesscompliance.com/blog/massachusetts-llc-annual-report-late-in-2026-penalties-dissolution-timeline-3-fix-steps) |
| CT annual report (if CT-formed) | CT Secretary of the State | **All LLCs Jan 1 to Mar 31** (changed ~2018; older guides wrong); \$80 [CT SOTS](https://portal.ct.gov/sots/press-releases/previous-years/2021-press-releases/secretary-of-the-state-merrill-reminds-businesses-they-can-file-annual-reports-directly-at), [src](https://businessanywhere.io/connecticut-llc-annual-report/) | Receipt | CT forfeiture undercuts the MA foreign registration. Late fee disputed [VERIFY] |
| Registered agent | Agent or self | Annual subscription | Contract | Default judgments from service to a stale address |
| DBA certificate | Town clerk (MA c.110 §5) | Typically 4-year renewal | Certificate | Banks/GCs ask. **[VERIFY with town]** |
| BOI / FinCEN | n/a | **Domestic companies exempt**: Mar 2025 interim rule finalized Aug 2026 [src](https://www.sheppard.com/insights/blogs/fincen-finalizes-corporate-transparency-act-rollback), [src](https://www.adamsandreese.com/insights/fincen-finalizes-exemption-of-us-companies-from-beneficial-ownership-reporting) | n/a | Track as N/A; watch for scam "BOI fee" letters |

### Trade licensing
| Obligation | Filed with | Cadence | Evidence | How it bites |
|---|---|---|---|---|
| MA HIC registration | Office of Consumer Affairs (MA Contractor Hub) | Every 2 years; \$100 per mass.gov, some sites \$150 [VERIFY] [mass.gov](https://www.mass.gov/how-to/renew-your-home-improvement-contractor-registration) | HIC # (required on contracts and ads) | Lapse undermines contract enforcement, Guaranty Fund exposure, permit denials. Renewal needs the WC affidavit, so a WC lapse breaks HIC |
| MA Construction Supervisor License (CSL) | BBRS (Contractor Hub) | 2 years, expires on holder's **birthday**; 12 CE hours unrestricted / 10 restricted [mass.gov](https://www.mass.gov/info-details/continuing-education-for-construction-supervisors) | License card, CE certs | Needed for structural permits; CE deadline comes before expiry. Belongs to a person (Matt), not the entity |
| Local building permits | Towns | Per job | Permit card | Require WC proof |

### Federal and state tax
| Obligation | Filed with | Cadence | Notes |
|---|---|---|---|
| Form 941 | IRS | Quarterly Apr 30 / Jul 31 / Oct 31 / Jan 31; EFTPS deposits usually monthly by the 15th | Payroll provider usually files: track as verify-filed |
| Form 940 (FUTA) | IRS | Jan 31 | Same |
| W-2 / W-3 | SSA, employees, MA DOR | Jan 31 | MA M-3 reconciliation too |
| 1099-NEC | IRS + payee | Jan 31; **threshold \$2,000 for payments made in 2026+** (was \$600) under OBBBA [src](https://www.patriotsoftware.com/blog/accounting/1099-reporting-threshold/) | Collect W-9 **before** paying any vendor |
| Form 1065 + K-1s (multi-member only) | IRS | Mar 15 (Mar 16 in 2026); 6-month extension via 7004 | Late penalty per partner per month (~\$255 inflation-adjusted [VERIFY]) even with zero tax |
| MA Form 3 (multi-member only) | MA DOR | Same as federal [mass.gov](https://www.mass.gov/info-details/tax-due-dates-and-extensions) | Penalties despite no tax |
| MA 63D-ELT (optional PTE excise) | MA DOR | Elected annually on timely Form 3; extension doesn't extend payment [mass.gov](https://www.mass.gov/service-details/elective-pass-through-entity-excise) | CPA decision. New 2026 4% Ch. 63E election only matters above ~\$1.1M surtax threshold [src](https://aafcpa.com/2026/08/31/massachusetts-new-4-pte-tax-what-pass-through-businesses-need-to-know-for-2026/) |
| CT-1065/CT-1120SI | CT DRS | Mar 15 if CT-source income | CT PET elective since 2024 [src](https://portal.ct.gov/drs/taxes/pass-through-entity/tax-information) [VERIFY CT nexus] |
| Estimated taxes (owners) | IRS 1040-ES, MA 1-ES | Apr 15 / Jun 15 / Sep 15 / Jan 15 | Per owner |
| MA withholding (M-941) | MA DOR (MassTaxConnect) | Frequency assigned; monthly due 15th of next month (quarter-end months: last day of next month); quarterly due last day after quarter; **zero-wage returns still required** [mass.gov](https://www.mass.gov/info-details/form-m-941-instructions-tax-return-of-income-taxes-withheld) | Common penalty source |
| MA sales/use tax | MA DOR | Contractors generally **don't collect** sales tax on real-property work (they're the consumer of materials); **use tax** owed on untaxed out-of-state purchases [Directive 14-2](https://www.mass.gov/directive/directive-14-2-application-of-sales-tax-to-cabinetmakers) | Audit exposure if materials bought online/NH [VERIFY ST-10 applicability] |

### Payroll / employment (2 W-2s)
| Obligation | Filed with | Cadence | Notes |
|---|---|---|---|
| MA DUA wage report + contributions | DUA (UI Online) | Quarterly Apr 30 / Jul 31 / Oct 31 / Jan 31 by 3pm [mass.gov](https://www.mass.gov/how-to/submit-employment-and-wage-detail-report) | Includes EMAC + Workforce Training Fund; delinquent 30 days past due [mass.gov](https://mass.gov/guides/guide-to-employer-contributions-to-dua) |
| MA PFML | MA DOR | Quarterly, end of month after quarter; 2026 rate 0.46% for under 25 employees [src](https://natlawreview.com/article/massachusetts-announces-paid-family-and-medical-leave-2026-contribution-rates) | New hires need the PFML notice within 30 days or employer loses ability to contest claims |
| New-hire reporting | MA DOR | Within 14 days | |
| I-9 | On file | At hire; retain 3 years after hire or 1 year after termination, whichever later | |
| Workplace posters | n/a | Annual refresh | |

### Insurance
| Obligation | With | Cadence | Notes |
|---|---|---|---|
| GL renewal (Kinsale) | Kinsale via Titan | Annual, Oct 13 | 60-90 days lead for app + loss runs |
| GL premium audit | Carrier auditor | Post-expiry | Wants payroll registers, GL, quarterly tax filings, **sub COIs** (uninsured subs get charged as payroll). Refusal can trigger up to 200% noncompliance charge (carrier-specific) [src](https://www.bitco.com/services/premium-audit) |
| Workers' comp + audit | WC carrier | Annual | Mandatory with employees; LLC members can exempt themselves. Penalties: stop-work order, \$100/day (\$250/day under appeal), up to 3 years debarment from public contracts [mass.gov](https://www.mass.gov/info-details/workers-compensation-insurance-requirements) |
| Commercial auto, umbrella | | Annual | Auto ID cards to vehicle record |

### Vehicle
| Obligation | Agency | Cadence | Notes |
|---|---|---|---|
| Registration | MA RMV | 1-2 years | |
| Safety inspection | Inspection station | Annual (sticker month) | |
| USDOT number | FMCSA | **Required in MA even intrastate for vehicles ≥ 10,001 lb GVWR** [mass.gov](https://www.mass.gov/regulatory-bulletin/new-usdot-number-requirement-for-intrastate-cmvs); biennial MCS-150 update keyed to USDOT digits | Check truck/combination GVWR; missed update deactivates the number |

### OSHA / safety
| Obligation | Rule | Notes |
|---|---|---|
| Silica (29 CFR 1926.1153) | Grinding for resurfacing and drilling injection ports generate silica. Needs a **written exposure control plan**, competent person, Table 1 controls (wet/vacuum shrouds), medical exams if respirator required 30+ days/year (every 3 years) [OSHA FAQ](https://www.osha.gov/sites/default/files/SilicaConstructionFAQs.pdf) | Highest OSHA citation risk for concrete work. Annual plan review as an obligation |
| OSHA 300/300A | **Partially exempt if ≤ 10 employees all last year**; fatality 8h / hospitalization-amputation 24h reporting still applies [src](https://www.marshmma.com/us/insights/details/osha-recordkeeping-requirements.html) | GC prequal asks for 300 logs; keep them voluntarily |
| HazCom (SDS for epoxies, polyurethanes, sealers), training records | 1926.59 | Ongoing, at hire |

### Digital and other renewals
Domains, Google Workspace, QBO, Pipedrive, Quo, Vercel, Upstash, Gemini prepay balance, Google OAuth tokens. Track cost, auto-renew flag, and payment card (expired cards cause silent renewal failures).

### Only if bidding public / commercial
| Item | Rule |
|---|---|
| MA prevailing wage | Schedule from the awarding authority; **weekly certified payroll** + signed statement; keep 3 years [mass.gov](https://www.mass.gov/info-details/prevailing-wage-for-contractors) |
| Bonds | 5% bid deposit; payment bond ≥ 50% on public contracts > \$25k (c.149 §29) [mass.gov](https://www.mass.gov/doc/construction-requirements/download) |
| DCAMM certification | c.149/149A building projects ≥ \$150k and filed sub-bids > \$25k; annual update statements [mass.gov](https://www.mass.gov/dcamm/certification) |
| OSHA 10 | All workers on MA public construction (c.30 §39S) [VERIFY threshold] |
| Vendor registrations | COMMBUYS, SAM.gov (annual renewal), optional MA SDO certification |

## 2. COI workflow notes

A request needs: holder's exact legal name + address; additional insured? for ongoing ops (CG 20 10) and/or completed ops (CG 20 37), and contracts requiring both need both; primary and non-contributory wording (CG 20 01); waiver of subrogation (CG 24 04); required edition dates; limits; project/job address for the description box; deadline. The ACORD 25 is informational only: a "SUBR WVD" checkbox means nothing without the endorsement on the policy ([Jones CG 20 10](https://getjones.com/endorsements/general-liability/CG20101219), [IIABA](https://www.independentagent.com/?p=8421), [servicemag](https://www.servicemag.org/guides/additional-insured-coi-contractor)).

Flow to build: request arrives (email/text/PM portal) → extract fields → check against the policy's endorsements (Kinsale often uses blanket AI/waiver "where required by written contract," which means a written contract/work order must exist) → request from Titan or self-issue if portal → store COI against holder + job → after the October renewal, auto-reissue to all active holders.

**Broker self-service portals are common**: HawkSoft, Vertafore AgencyOne, NowCerts, Momentum, Applied CSR24 ([HawkSoft](https://www.hawksoft.com/self-service-certificates/), [NowCerts](https://nowcerts.com/features/self-serve-certificates), [Vertafore](https://coverager.com/vertafore-unveils-integrated-certificates-solution-to-remove-service-bottlenecks-and-accelerate-distribution-velocity-for-agencies/)). Ask Titan; enablement is per agency.

## 3. Commercial / GC prequalification packet

W-9; certificate(s) of good standing; HIC + CSL; sample COIs (GL, WC, auto, umbrella) + endorsement copies; **3-year EMR letters** (EMR ≥ 1.25 needs an explanation); OSHA 300/300A for 3 years; written safety program + silica exposure control plan; surety bonding-capacity letter (often ≤ 90 days old); financial statements or bank reference; references + project list; litigation/default/debarment questions; key personnel licenses; diversity certs ([CNA guide](https://www.cna.com/sites/default/files/assets/04e28d61-f36a-4d05-a93b-255264df7142/CNA-RC-SubPrequal-Guide.pdf), [Paric 2026 form](https://www.paric.com/wp-content/uploads/2026/01/2026-Subcontractor_Supplier-Prequalification.pdf)).

Early gaps: a surety relationship (needs reviewed/compiled financials, blocked on the 2026 books) and EMR (small payrolls may have no experience rating; ask the WC carrier).

## 4. Software survey

| Product | Covers | Pattern worth stealing |
|---|---|---|
| **Mosey** | Entity + payroll-tax accounts, registered agent, government mail | **Calendar generated from a business profile** (answer questions, obligations appear); unified government-mail inbox with AI summaries; per-agency credentials [mosey](https://mosey.com/platform/entity-compliance/) |
| **Harbor Compliance** | Entity + license tracking | State-database feeds verify good standing; licenses assigned to people [harbor](https://www.harborcompliance.com/license-manager-software) |
| **Gusto** | Payroll filings, state registration via Middesk | Payroll filings become verify-filed; outstanding registrations as a home to-do [Gusto](https://support.gusto.com/article/222579327100000/Let-Gusto-help-you-with-state-tax-registration) |
| **myCOI / TrustLayer / Certificial / Jones / Billy** | Collecting vendor COIs | **Requirement template vs actual coverage, with a gap list**; no-login upload links; AI gap explanations; expiry-driven renewal requests [Jones](https://getjones.com/property-management/), [Billy](https://billyforinsurance.com/resources/best-coi-compliance-software-construction/), [Certificial](https://www.certificial.com/blog-post/trustlayer-alternatives) |

AAC mostly *issues* COIs, so those tools are the wrong purchase, but their requirement-vs-policy gap check is exactly right for incoming requests.

## 5. Minimal data model

```
obligation_def    id, title, category (entity|license|tax|payroll|insurance|vehicle|safety|digital|public_bid),
                  jurisdiction (US|MA|CT|town:X), agency, portal_url, credential_ref,
                  applies_if (json: entity_type, formation_state, has_employees, gvwr>=10001, bidding_public),
                  recurrence (json: {kind: fixed|anniversary|birthday|quarterly|monthly|per_event|on_expiry,
                              anchor_field, month/day, offset_days, business_day_adjust}),
                  lead_days [90,30,7], owner_person_id, est_cost, penalty_note, source_url,
                  depends_on[], auto_handled_by (payroll|cpa|broker|null)
obligation_instance  id, def_id, entity_id, period_label, due_date, status (upcoming|in_progress|
                  filed|confirmed|overdue|waived|n_a), completed_at, confirmation_no, amount_paid, notes
document          id, type (coi|policy|endorsement|license|good_standing|w9|filing_receipt|plan|emr_letter),
                  issuer, effective_date, expiry_date, blob_url, linked_instance_ids[], linked_policy_id
policy            id, line (gl|wc|auto|umbrella), carrier, number, effective, expiry, limits, endorsements[]
cert_holder       id, name, address, requires (ai_ongoing, ai_completed, pnc, wos, limits), job_id
coi_request       id, holder_id, received_via, received_at, due_at, gap_check, status, issued_doc_id
```

Rules: definitions generate instances; instances can't reach `confirmed` without evidence; document expiries spawn renewal instances; anniversary/birthday dates resolve from entity/person records; payroll/CPA/broker-handled items are verify-filed. (`entity_id` added for the planned entity transition.)

## Open facts to seed

Formation state + tax class; DBA on file; truck GVWR; actual HIC fee and both renewal dates; Kinsale blanket AI/waiver endorsements; WC carrier + EMR; whether Titan offers a COI portal.
