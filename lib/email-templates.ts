export type EmailTemplateId = "collaboration" | "remote-teamup";

export type EmailTemplate = {
  id: EmailTemplateId;
  label: string;
  subject: string;
  body: string;
};

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: "collaboration",
    label: "Collaboration suggestion",
    subject: "Collaboration suggestion",
    body: `Hi {{name}},
Is this you, right?
{{url}}
I'm currently looking for one strong long-term collaborator to partner with on client projects - someone I can build with consistently, not just bring in as a contractor here and there.

I wanted to reach out because I think this could be a strong fit for both of us.
I'm a Web & AI Engineer with 10+ years of experience, and I've already worked this way with other developers on quality client work. It's been a very effective setup, and I'm now looking to build a similar long-term collaboration with the right person.

The way I usually work is simple:

I handle lead generation, proposals, project execution, and delivery.
You remain the client-facing owner when needed, especially for calls or account-based communication.

We can collaborate through your existing Upwork profile in a fully compliant subcontracting / agency-style setup, or work with direct remote clients outside platforms.
In other words, I take care of the technical and operational side, and together we create a setup that's reliable, scalable, and beneficial for both of us.

Revenue split would be:

20% to you for projects done through your Upwork profile.
50/50 for direct remote projects.

Why this tends to work well:

You keep control of your profile, client communication, and payments.
There's no upfront risk for you.
I focus on doing the actual work and helping increase project volume.
I'm looking for a real long-term partnership, not a short-term deal.

If this sounds like something you'd be open to, I'd love to have a quick chat and see if there's a fit.
Email: {{sender_email}}

Best,
{{sender}}
`,
  },
  {
    id: "remote-teamup",
    label: "Remote team up",
    subject: "Looking to Team Up on Remote Projects",
    body: `Hey {{name}},

Hope you're doing well.

I found your profile through {{url}}.
I'm {{sender}}, a full stack developer working mostly on remote software projects.

Right now I'm looking to connect with another developer to team up, hunt remote jobs together, and make money by landing projects together long term.

I feel like there's a lot more opportunity when good developers work together instead of solo grinding all the time.

If you're interested, let me know and we can chat more.

Cheers,
{{sender}}
`,
  },
];

const TEMPLATE_BY_ID = Object.fromEntries(
  EMAIL_TEMPLATES.map((t) => [t.id, t]),
) as Record<EmailTemplateId, EmailTemplate>;

export function getEmailTemplate(id: EmailTemplateId): EmailTemplate {
  return TEMPLATE_BY_ID[id];
}

export function isEmailTemplateId(value: string): value is EmailTemplateId {
  return value in TEMPLATE_BY_ID;
}

const SELECTED_KEY = "mail.templateId";
const subjectKey = (id: EmailTemplateId) => `mail.template.${id}.subject`;
const bodyKey = (id: EmailTemplateId) => `mail.template.${id}.body`;

/** Read saved template id, migrating legacy v2 keys into the collaboration template. */
export function loadSelectedTemplateId(): EmailTemplateId {
  if (typeof window === "undefined") return "collaboration";
  migrateLegacyTemplateStorage();
  const raw = localStorage.getItem(SELECTED_KEY);
  if (raw && isEmailTemplateId(raw)) return raw;
  return "collaboration";
}

export function saveSelectedTemplateId(id: EmailTemplateId): void {
  localStorage.setItem(SELECTED_KEY, id);
}

export function loadActiveTemplateState(): {
  id: EmailTemplateId;
  subject: string;
  body: string;
} {
  const id = loadSelectedTemplateId();
  return { id, ...loadTemplateContent(id) };
}

export function loadTemplateContent(id: EmailTemplateId): {
  subject: string;
  body: string;
} {
  const defaults = getEmailTemplate(id);
  if (typeof window === "undefined") {
    return { subject: defaults.subject, body: defaults.body };
  }
  migrateLegacyTemplateStorage();
  const subject = localStorage.getItem(subjectKey(id));
  const body = localStorage.getItem(bodyKey(id));
  return {
    subject: subject ?? defaults.subject,
    body: body ?? defaults.body,
  };
}

export function saveTemplateContent(
  id: EmailTemplateId,
  subject: string,
  body: string,
): void {
  localStorage.setItem(subjectKey(id), subject);
  localStorage.setItem(bodyKey(id), body);
}

/** One-time migration from mail.subject.v2 / mail.body.v2. */
function migrateLegacyTemplateStorage(): void {
  const legacySubject = localStorage.getItem("mail.subject.v2");
  const legacyBody = localStorage.getItem("mail.body.v2");
  if (legacySubject === null && legacyBody === null) return;
  if (localStorage.getItem(subjectKey("collaboration")) === null && legacySubject !== null) {
    localStorage.setItem(subjectKey("collaboration"), legacySubject);
  }
  if (localStorage.getItem(bodyKey("collaboration")) === null && legacyBody !== null) {
    localStorage.setItem(bodyKey("collaboration"), legacyBody);
  }
  localStorage.removeItem("mail.subject.v2");
  localStorage.removeItem("mail.body.v2");
}
