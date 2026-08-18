export type ExamplePrompt = {
  id: string;
  title: string;
  summary: string;
  prompt: string;
};

export const EXAMPLE_PROMPTS: ExamplePrompt[] = [
  {
    id: 'restaurant',
    title: 'Neighbourhood restaurant',
    summary: 'A tasting-menu kitchen in Bandra West, with real dishes and a booking form.',
    prompt: `Build a multi-page website for Saffron Clay, a 42-seat contemporary Indian restaurant in Bandra West, Mumbai. Audience: diners aged 28–50 who book tasting menus and weekend lunches; tone is warm, precise, and unhurried — never slangy, never corporate. Design direction: editorial. Use NEXTJS.

Sections in this exact order on the homepage:
1) Hero — full-bleed photograph of a monsoon-lit dining room, headline “Clay, fire, and the Konkan coast”, subhead “Tasting menus in Bandra West”, primary CTA “Reserve a table”, secondary CTA “View the menu”. Phone +91 98200 11420.
2) Tonight’s menu — five dishes with short stories: Crab butter pepper (₹1,280), Millet khichdi with ghee tadka (₹640), Duck roast with kokum (₹1,450), Jackfruit steak (₹890), Filter-coffee mishti doi (₹320). Note allergens: shellfish, dairy, gluten.
3) The room — 120 words on the 1978 bungalow, open kitchen, and no-speakerphone rule.
4) Chefs — Ananya Deshmukh (Goa) and Rohan Iyer (Pune); one paragraph each.
5) Reservations — form: date, time (19:00 / 19:30 / 21:00), party size 1–8, name, email, phone. Address: 14 Hill Road, Bandra West, Mumbai 400050. Hours Tue–Sun 12:30–15:00 and 19:00–23:00. Closed Monday.
6) Private dining — the Mezzanine for 12, tasting-only, ₹4,500 per person.
7) Journal — three short posts: monsoon produce, toddy vinegar, Sunday thali.
8) Footer — email hello@saffronclay.example.com, Instagram handle as text, GSTIN 27AABCS1234A1Z5.

No Lorem ipsum. Indian names, rupee prices, and this Mumbai address only.`,
  },
  {
    id: 'clinic',
    title: 'Family clinic',
    summary: 'A calm two-doctor practice in Kothrud, with hours, doctors, and appointments.',
    prompt: `Build a website for Dr. Meera Iyer Family Clinic, a two-doctor neighbourhood practice in Kothrud, Pune. Audience: parents and older adults booking same-week appointments; many read Marathi and English. Tone: calm, plain, trustworthy. Design direction: minimal. Use NEXTJS. High contrast, large tap targets, no decorative animation.

Pages: Home, Doctors, Services, Appointments, Patient information, Contact.

Homepage sections in order:
1) Hero — “Family medicine in Kothrud”, subhead “Same-week appointments for children and adults”, CTA “Book an appointment”, secondary “Call the clinic”. Phone +91 20 2543 1188.
2) Hours & address — Mon–Sat 09:00–13:00 and 17:00–20:00; Sunday emergency slot 10:00–12:00 by phone only. 42 Paud Road, Kothrud, Pune 411038. Parking for four cars behind the building.
3) Doctors — Dr. Meera Iyer (MBBS, DNB Family Medicine) and Dr. Arjun Kulkarni (MBBS, DCH). One short paragraph each; languages English, Marathi, Hindi.
4) Services — child wellness, adult chronic care (diabetes, BP), vaccines, basic labs. No cosmetic procedures.
5) Appointments — form: patient name, age, phone, preferred day, new or returning. Note that this is a request, not a confirmed slot.
6) Patient information — bring previous reports; walk-ins taken after booked patients; no opioid prescriptions from this clinic.
7) Footer — email clinic@iyerfamily.example.com, registration MH-MED-441902.

No stock “compassionate care” copy. No Lorem ipsum. Keep Pune addresses, rupee-free fees listed as “ask at reception”, and these doctor names.`,
  },
  {
    id: 'portfolio',
    title: 'Designer portfolio',
    summary: 'A Bengaluru product designer’s site with real case studies and rupee budgets.',
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
];

export const PROMPT_TIPS = {
  title: 'How to write a good prompt',
  rules: [
    {
      title: 'Describe sections in order',
      detail: 'List the homepage blocks the way a visitor should meet them: hero, then proof, then the action you want.',
    },
    {
      title: 'Give real content, not placeholders',
      detail: 'Use the client’s name, city, prices, phone, and hours. “Lorem ipsum” and “add content later” produce empty sites.',
    },
    {
      title: 'Name the audience and tone',
      detail: 'Say who will read the site and how it should sound — warm and unhurried, calm and plain, or direct and graphic.',
    },
    {
      title: 'Ask for one thing at a time',
      detail: 'The first prompt should describe the site. Save “also add a blog” or a redesign for the next message.',
    },
  ],
  examples: [
    {
      label: 'Before',
      text: 'Make a website for a restaurant. Make it look modern and add a menu.',
    },
    {
      label: 'After',
      text: 'Build a site for Saffron Clay, a 42-seat kitchen in Bandra West. Audience: diners 28–50. Tone: warm and precise. Homepage in this order: hero with “Reserve a table”, tonight’s menu with five priced dishes, the 1978 bungalow, two chefs, then a reservation form.',
    },
  ],
} as const;
