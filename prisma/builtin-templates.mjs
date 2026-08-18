/** Ten built-in Navroop templates. Indian-context placeholders. example.com only. */

export const BUILT_IN_TEMPLATES = [
  {
    slug: 'restaurant',
    name: 'Neighbourhood restaurant',
    description: 'A tasting-menu restaurant site for a Mumbai neighbourhood kitchen.',
    category: 'restaurant',
    stack: 'NEXTJS',
    designDirection: 'editorial',
    sortOrder: 10,
    prompt: `Build a multi-page website for Saffron Clay, a 42-seat contemporary Indian restaurant in Bandra West, Mumbai. Audience: diners aged 28–50 who book tasting menus and weekend lunches; tone is warm, precise, and unhurried — never slangy, never corporate. Design direction: editorial. Use NEXTJS.

Sections in this exact order on the homepage:
1) Hero — full-bleed photograph of a monsoon-lit dining room, headline “Clay, fire, and the Konkan coast”, subhead “Tasting menus in Bandra West”, primary CTA “Reserve a table”, secondary CTA “View the menu”. Phone +91 98200 11420.
2) Tonight’s menu — five dishes with short stories: Crab butter pepper (₹1,280), Millet khichdi with ghee tadka (₹640), Duck roast with kokum (₹1,450), Jackfruit steak (₹890), Filter-coffee mishti doi (₹320). Note allergens: shellfish, dairy, gluten.
3) The room — 120 words on the 1978 bungalow, open kitchen, and no-speakerphone rule.
4) Chefs — Ananya Deshmukh (Goa) and Rohan Iyer (Pune); one paragraph each.
5) Reservations — form: date, time (19:00 / 19:30 / 21:00), party size 1–8, name, email, phone. Address: 14 Hill Road, Bandra West, Mumbai 400050. Hours Tue–Sun 12:30–15:00 and 19:00–23:00. Closed Monday.
6) Private dining — the Mezzanine for 12, tasting-only, ₹4,500 per person.
7) Journal — three short posts: monsoon produce, toddy vinegar, Sunday thali.
8) Footer — email hello@saffronclay.example.com, Instagram handle as text, GSTIN 27AABCS1234A1Z5. No Lorem ipsum. Indian names, rupee prices, and this Mumbai address only.`,
  },
  {
    slug: 'portfolio-designer',
    name: 'Designer portfolio',
    description: 'A bold portfolio for an independent product designer in Bengaluru.',
    category: 'portfolio',
    stack: 'NEXTJS',
    designDirection: 'bold',
    sortOrder: 20,
    prompt: `Build a personal portfolio for Kavya Menon, an independent product designer in Koramangala, Bengaluru. Audience: design leads at Indian startups and a few European studios who hire for 6–12 week product sprints. Tone: direct, graphic, a little dry. Design direction: bold. Use NEXTJS.

Pages: Home, Work, About, Notes, Contact.

Homepage sections in order:
1) Hero — oversized name “Kavya Menon”, one line “Product design for fintech and civic tools”, city “Bengaluru”, CTA “See selected work”.
2) Selected work — four case studies, each with a problem, constraint, and outcome. (a) PayTogether — UPI split-bills for housing societies in Pune; cut support tickets 31%. (b) Ward Pulse — Kannada/English civic complaints for BBMP ward 89; first response under 48 hours. (c) Shelf & Seed — packaging system for a Kochi spice brand; +22% wholesale orders. (d) Night Rail — wayfinding for a late-night ladies’ coach campaign with Indian Railways; tested with 18 commuters at KSR Bengaluru.
3) Method — research in the room, not remote-only; Figma + paper; no dark-pattern checkout work.
4) About — born in Thrissur, NID Gandhinagar, six years at two Bengaluru product companies, now independent. Studio: 218, 5th Main, Koramangala 4th Block, Bengaluru 560034. Phone +91 98450 22811.
5) Notes — three 80-word essays: bilingual UI, caste-aware user research, designing for 2G railway Wi-Fi.
6) Contact — form (name, work email, project type, budget band ₹2L / ₹5L / ₹10L+). Email kavya@studio-menon.example.com. Availability: taking two sprints from October.

No stock “passionate designer” copy. No Lorem ipsum. Keep Indian cities, rupee budgets, and Kavya’s name throughout.`,
  },
  {
    slug: 'medical-clinic',
    name: 'Medical clinic',
    description: 'A calm clinic site for a family practice in Pune.',
    category: 'clinic',
    stack: 'NEXTJS',
    designDirection: 'minimal',
    sortOrder: 30,
    prompt: `Build a website for Dr. Meera Iyer Family Clinic, a two-doctor neighbourhood practice in Kothrud, Pune. Audience: parents and older adults booking same-week appointments; many read Marathi and English. Tone: calm, plain, trustworthy. Design direction: minimal. Use NEXTJS. High contrast, large tap targets, no decorative animation.

Pages: Home, Doctors, Services, Appointments, Patient information, Contact.

Homepage sections in order:
1) Hero — “Family medicine in Kothrud”, subhead “Same-week appointments for children and adults”, CTA “Book an appointment”, secondary “Call the clinic”. Phone +91 20 2543 1188.
2) Hours & address — Mon–Sat 09:00–13:00 and 17:00–20:00; Sunday emergency slot 10:00–12:00 by phone only. 42 Paud Road, Kothrud, Pune 411038. Parking for four cars behind the building.
3) Doctors — Dr. Meera Iyer (MBBS, DNB Family Medicine, 14 years) and Dr. Arjun Kulkarni (MBBS, MD Paediatrics, 9 years). Languages: English, Marathi, Hindi, Tamil.
4) Services — child immunisation (IAP schedule), diabetes and BP follow-up, women’s health, minor procedures, medical certificates for school and office. No cosmetic procedures.
5) How visits work — walk-ins accepted before 11:00; online booking for 15-minute slots; bring previous reports; Aadhaar not required for care.
6) Fees — first consult ₹800, follow-up ₹500, paediatric consult ₹900. Payment: UPI, card, cash.
7) Patient information — fasting rules for blood tests, vaccine reminders, what to do after hours (go to Deenanath Mangeshkar Hospital emergency).
8) Appointment form — patient name, age, phone, preferred doctor, date, reason (short). Email clinic@meera-iyer.example.com.

Footer: registration numbers, privacy note, no stock medical stock-photo collage. Indian names, Pune address, rupee fees. No Lorem ipsum.`,
  },
  {
    slug: 'real-estate',
    name: 'Real estate agency',
    description: 'A premium agency site for South Delhi residences.',
    category: 'realestate',
    stack: 'NEXTJS',
    designDirection: 'premium',
    sortOrder: 40,
    prompt: `Build a website for Atelier Homes, a boutique residential agency in Greater Kailash I, New Delhi. Audience: families buying 3–4 BHK homes and NRIs leasing for the school year. Tone: refined, specific, never “luxury lifestyle” fluff. Design direction: premium. Use NEXTJS.

Pages: Home, Residences, Neighbourhoods, Selling, About, Contact.

Homepage sections in order:
1) Hero — still photograph of a shaded GK-I courtyard, headline “Homes with a South Delhi address”, CTA “View residences”, secondary “Talk to an advisor”.
2) Featured residences — four listings: (a) 4 BHK, Block E, Greater Kailash I, 2,850 sq ft, ₹11.4 Cr, private terrace. (b) 3 BHK, Panchsheel Park, 1,920 sq ft, ₹7.8 Cr, park-facing. (c) Farmhouse lease, Chattarpur, 6,000 sq ft, ₹4.2 L/month, 11 months. (d) Builder floor, Defence Colony, 2,100 sq ft, ₹6.1 Cr. Each card: BHK, society, size, price, one sentence on light and access.
3) Neighbourhoods — GK-I, Defence Colony, Panchsheel, Vasant Vihar: schools (Vasant Valley, Modern School), metro (GK, AIIMS), weekend markets.
4) How we work — measured drawings before listing, no bait prices, NRI video walkthroughs at 18:30 IST.
5) Advisors — Radhika Sethi and Vikram Malhotra; both on-site six days a week.
6) Selling with us — preparation, photography, private first week for known buyers, then public listing.
7) Contact — 14-A, N-Block, Greater Kailash I, New Delhi 110048. Phone +91 11 4165 2090. Email desk@atelierhomes.example.com. Form: name, phone, buying or selling, budget band.

RERA note in the footer: agency registration to be shown as a placeholder number DL/RERA/AG/2024/1182. Use Indian names, crore/lakh prices, and this Delhi address. No Lorem ipsum.`,
  },
  {
    slug: 'local-service',
    name: 'Local electrician',
    description: 'A clear service site for a licensed electrician in Jaipur.',
    category: 'business',
    stack: 'NEXTJS',
    designDirection: 'technical',
    sortOrder: 50,
    prompt: `Build a website for Gopal Electricals, a licensed residential and small-shop electrician covering Jaipur (Vaishali Nagar, C-Scheme, Malviya Nagar, Mansarovar). Audience: homeowners and shopkeepers who need same-day fault finding, not a corporate facilities team. Tone: plain, technical, honest about what is and is not an emergency. Design direction: technical. Use NEXTJS.

Pages: Home, Services, Pricing, Safety, Service area, Book a visit.

Homepage sections in order:
1) Hero — “Licensed electrician in Jaipur”, subhead “Fans, boards, inverters, and shop lighting — usually same day”, CTA “Book a visit”, secondary “WhatsApp +91 94140 66215”.
2) When to call today — no power in one room, burning smell at the board, inverter not charging, shop signage dead before opening.
3) Services — new points and boards, MCB/RCCB replacement, inverter and battery health, false-ceiling LED layouts, earthing check, AMC for three shops on MI Road. Not: high-tension work, solar EPC, or multi-storey rising mains.
4) Pricing — visit charge ₹350 within the ring road (adjusted against work). Fan install ₹450 each. Board rewire quoted on site. Evening slot (19:00–21:00) +₹200.
5) Safety — licensed with the Jaipur Vidyut Vitran Nigam contractor list; we isolate the MCB before opening a board; we do not work on wet terrace pumps in rain.
6) Service area — pin codes 302001, 302006, 302017, 302020, 302021. Outside this, we say no.
7) Book a visit — form: name, phone, pin code, problem (short), preferred slot (10:00–13:00 / 16:00–19:00). Address of the workshop: 7, Patel Marg, Mansarovar, Jaipur 302020. Owner: Harish Gopal.
8) Footer — GSTIN 08AABCG7788Q1Z3, email jobs@gopal-electricals.example.com.

No cartoon mascots. Indian name, Jaipur pin codes, rupee prices. No Lorem ipsum.`,
  },
  {
    slug: 'personal-trainer',
    name: 'Personal trainer',
    description: 'A bold site for a strength coach in Hyderabad.',
    category: 'personal',
    stack: 'NEXTJS',
    designDirection: 'bold',
    sortOrder: 60,
    prompt: `Build a website for Coach Nisha Reddy, a strength and conditioning coach training in Jubilee Hills, Hyderabad. Audience: desk workers 25–40 who want three sessions a week and a plan they will actually follow in Indian summers. Tone: blunt, encouraging, no “shred” clichés. Design direction: bold. Use NEXTJS.

Pages: Home, Coaching, Programmes, Proof, Book.

Homepage sections in order:
1) Hero — large type “Get strong in this climate”, subhead “Personal training in Jubilee Hills — mornings before the heat”, CTA “Book a consult”, secondary “See programmes”.
2) Who this is for — people returning after a gap, new parents, and anyone tired of random YouTube splits. Not for contest prep this season.
3) Programmes — (a) Foundations, 8 weeks, 3×/week, ₹12,000/month. (b) Desk-to-deadlift, 12 weeks, form + posterior chain, ₹15,000/month. (c) Small group (max 4), 6:30 AM, ₹7,500/month. All include a simple food note for Andhra/Telangana home food — rice, gongura, curd — not imported meal plans.
4) A week with Nisha — sample: Monday squat pattern, Wednesday push/pull, Friday hinges and carries; Saturday optional walk on KBR track.
5) Proof — three client notes with first names only: Sandeep (36, Gachibowli, back pain eased), Ayesha (29, Banjara Hills, first unassisted pull-up), Ramesh (44, blood pressure down with his physician’s plan).
6) Studio — 3rd floor, Road No. 10, Jubilee Hills, Hyderabad 500033. Open 05:30–10:00 and 16:30–20:00. Closed Sunday.
7) Book — form: name, phone, goal, injuries, preferred slot. Phone +91 90001 77442. Email nisha@strong-hyd.example.com.

Footer: disclaimer that coaching is not medical advice. Indian names, Hyderabad address, rupee fees. No Lorem ipsum.`,
  },
  {
    slug: 'law-firm',
    name: 'Law firm',
    description: 'A premium firm site for commercial disputes in Chennai.',
    category: 'business',
    stack: 'NEXTJS',
    designDirection: 'premium',
    sortOrder: 70,
    prompt: `Build a website for Iyer & Krishnan, a six-lawyer commercial disputes and arbitration practice in T. Nagar, Chennai. Audience: mid-size company general counsel and family-business principals in Tamil Nadu and Karnataka. Tone: formal, exact, no marketing adjectives. Design direction: premium. Use NEXTJS.

Pages: Home, Practice, Lawyers, Insights, Contact.

Homepage sections in order:
1) Hero — wordmark, one line “Commercial disputes and arbitration”, CTA “Contact the chambers”, no stock gavel imagery.
2) Practice areas — shareholder disputes, contract claims, construction delay, domestic arbitration (MCIA / ad hoc), and insolvency appearances before NCLT Chennai. We do not take criminal matters or family law.
3) Approach — written advice in five working days; Tamil and English filings; we decline matters outside our list.
4) Lawyers — Senior counsel Priya Iyer (23 years, Madras High Court) and Partner Karthik Krishnan (14 years, arbitration). Associates listed by name only: Divya Raman, Farhan Ahmed, Meenakshi V, Arun Palani.
5) Insights — three 120-word notes: Section 29A extensions, stamp duty on arbitral awards in Tamil Nadu, and when a family firm should not send a legal notice.
6) Chambers — 2nd floor, 15 G.N. Chetty Road, T. Nagar, Chennai 600017. Hours 09:30–18:00 on court days. Phone +91 44 2834 5510. Email chambers@iyerkrishnan.example.com.
7) Contact form — name, organisation, role, phone, 200-word matter summary, conflict check (other party name). State that sending the form does not create a lawyer–client relationship.

Footer: Bar Council of Tamil Nadu & Puducherry enrolment placeholders, disclaimer required for Indian law firm sites. Indian names, Chennai address. No Lorem ipsum.`,
  },
  {
    slug: 'photography-studio',
    name: 'Photography studio',
    description: 'An editorial studio site for film and portraits in Kochi.',
    category: 'portfolio',
    stack: 'NEXTJS',
    designDirection: 'editorial',
    sortOrder: 80,
    prompt: `Build a website for Salt Line Studio, a two-person photography practice in Fort Kochi. Audience: magazines, architects, and couples who want film-leaning portraits — not loud wedding cinema. Tone: quiet, visual, short sentences. Design direction: editorial. Use NEXTJS. Large images, generous margins, few words.

Pages: Home, Work, About, Dates, Contact.

Homepage sections in order:
1) Hero — a single wide photograph (backwater light, no text overlay except the wordmark), CTA “View work”.
2) Work index — six series tiles: (a) Jew Town interiors for an architecture journal. (b) Monsoon portraits in Mattancherry. (c) A toddy shop kitchen at 6 AM. (d) A writer’s house in Alappuzha. (e) Silk and gold stills for a Chennai label. (f) A small wedding in Cherai — 40 guests, no drone.
3) About — Arun Varghese and Leela Fernandes; they shoot together; film and digital; studio days on weekdays only. Address: 8/214, Princess Street, Fort Kochi, Kochi 682001.
4) Dates — available for two editorial days a month and four portrait sessions. Peak monsoon (June–July) is studio-only.
5) Fees — portrait sitting ₹18,000 (two hours, 20 edits). Half-day editorial ₹42,000. Travel beyond Ernakulam quoted. Retainer for one magazine: ask.
6) Contact — form: name, project type (portrait / editorial / wedding), date window, city. Phone +91 98470 33109. Email desk@saltline.example.com.

Footer: © Salt Line Studio, Kochi. No “capturing memories” taglines. Indian names, Kochi address, rupee fees. No Lorem ipsum.`,
  },
  {
    slug: 'saas-landing',
    name: 'SaaS landing page',
    description: 'A technical landing page for a GST reconciliation tool.',
    category: 'saas',
    stack: 'NEXTJS',
    designDirection: 'technical',
    sortOrder: 90,
    prompt: `Build a single-page marketing site for LedgerFold, a GST reconciliation tool for Indian CA firms and in-house finance teams. Audience: chartered accountants and CFOs who live in GSTR-2B and purchase registers. Tone: precise, sceptical of hype, comfortable with GST vocabulary. Design direction: technical. Use NEXTJS.

Sections in this exact order:
1) Hero — “Reconcile GSTR-2B without the Friday scramble”, subhead “Match purchase registers to 2B, flag mismatches, export a review pack for the partner.” CTA “Start a 14-day trial”, secondary “See a sample pack”. No global-payroll metaphors.
2) Problem — three bullets: portal downloads that do not match Tally, ITC claims delayed by one missed invoice, juniors copying GSTINs by hand.
3) How it works — (a) Upload purchase register (xlsx). (b) Connect GSTN via the official API or drop the 2B JSON. (c) Review mismatches: invoice missing, GSTIN typo, tax-head split. (d) Export a PDF pack with the partner’s comments.
4) Who it is for — firms with 20–200 clients; in-house teams at manufacturers in Coimbatore and Rajkot. Not for individual ITR filing.
5) Pricing — Practice ₹2,499/month (5 GSTINs), Firm ₹7,999/month (25 GSTINs), Bench ₹19,999/month. GST extra. Annual = 10 months.
6) Security — data stays in India (Mumbai region), role-based access, audit log, no training on customer files.
7) Proof — quote from CA Sneha Kulkarni, Pune: “We closed 2B review a day earlier in the January cycle.” Another from Rahul Mehta, Ahmedabad CFO.
8) FAQ — e-invoice vs 2B, what happens if GSTN is down, can a junior lock a period.
9) Final CTA — trial form: name, work email, firm name, city, GSTIN count. Company: LedgerFold, 4th floor, WeWork Galaxy, 43 Residency Road, Bengaluru 560025. Phone +91 80 4123 9088. Email hello@ledgerfold.example.com.

Footer: product of an Indian company, not a US LLC. No Lorem ipsum.`,
  },
  {
    slug: 'event-wedding',
    name: 'Wedding planner',
    description: 'A playful-premium site for a wedding studio in Udaipur.',
    category: 'event',
    stack: 'NEXTJS',
    designDirection: 'playful',
    sortOrder: 100,
    prompt: `Build a website for Mehfil Studio, a wedding planning practice based in Udaipur that also produces smaller celebrations in Jaipur and Jodhpur. Audience: couples in India and NRIs planning 80–250 guest weddings who want colour and ritual, not a copy of a European vineyard. Tone: joyful, organised, specific. Design direction: playful (with premium restraint on type). Use NEXTJS.

Pages: Home, Weddings, Celebrations, Process, Dates, Enquire.

Homepage sections in order:
1) Hero — “Weddings that sound like home”, subhead “Udaipur, Jaipur, Jodhpur — mehfils, not templates”, CTA “See weddings”, secondary “Check dates”.
2) Selected weddings — three stories: (a) Amrita & Kabir, City Palace lakeside dinner, 140 guests, monsoon evening, sitar and a quiet phera. (b) Leah & Vikram, NRI couple, Jodhpur fort breakfast and a zenana courtyard mehendi. (c) Fatima & Ayaan, 90 guests, haveli in Udaipur, nikah at 11:00 and a night of qawwali.
3) Other celebrations — sangeet-only, 50th anniversary, and a Jaipur textile launch (not only weddings).
4) Process — discovery call, guest map, vendor shortlist (caterers who can do Rajasthani + Gujarati + a small continental table), run-of-show, on-ground team of eight.
5) What we do not do — destination copies of Italian villas, drone-only films, or guest lists over 400.
6) Dates — taking 12 weddings a year. Next open months listed as a simple table (month / still open).
7) Enquire — form: couple names, city you live in, wedding city, guest count, month, phone. Studio: 21, Gangaur Ghat Road, Udaipur 313001. Phone +91 294 242 1180. Email hello@mehfilstudio.example.com. Lead planners: Riya Sharma and Imran Qureshi.

Footer: Instagram as text, no “happily ever after” stock line. Indian names, Udaipur address. No Lorem ipsum.`,
  },
];
