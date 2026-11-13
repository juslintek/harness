// Static guidance: nothing here is read from the server. Each step names a screen or button that exists.
export type Target =
  | "now"
  | "runs"
  | "logs"
  | "approvals"
  | "usage"
  | "policies"
  | "board"
  | "hiring"
  | "hire-writing"
  | "marketing";

export interface Playbook {
  id: string;
  title: string;
  when: string;
  steps?: string[];
  note?: string;
  actions: { label: string; to: Target }[];
}

export interface MarketingKind {
  name: string;
  blurb: string;
  can: string[];
  cannot: string[];
  tools: string[];
  task: { title: string; type: string };
}

export const INTRO = {
  title: "Guidance, not live data",
  body: "These playbooks are written text. They do not read your organisation and nothing on them updates. Each step names a real screen or button; the buttons open those screens.",
};

export const GROUPS: { title: string; help: string; cards: Playbook[] }[] = [
  {
    title: "Run and monitor",
    help: "How to watch agents and keep control. Live means one run; everything else updates when something changes.",
    cards: [
      {
        id: "follow-run",
        title: "Follow a run live",
        when: "An agent is working and you want to watch what it does as it happens.",
        steps: [
          'Open Now and find the run under "Working now". Instance admins can also use Runs.',
          'Press "Follow live". The Run page opens and adds each new event as it arrives.',
          "Read the events. Use the chips (All, Messages, Commands, Guard, Errors) to show only one kind of event.",
          'If the status says "waiting for you", decide the command in the approval card at the top.',
        ],
        note: "Only one run is live. Logs, Now and Usage & budgets update when something changes, they are not a live feed. Runs and Follow are for instance admins.",
        actions: [
          {
            label: "Open Now",
            to: "now",
          },
          {
            label: "Open Runs",
            to: "runs",
          },
        ],
      },
      {
        id: "read-logs",
        title: "Read the logs",
        when: "You want to find what an agent did, or what the guard allowed or refused, after it happened.",
        steps: [
          "Open Logs. It searches the events of this organisation.",
          'Type a word from the command or message in Search events. Press "Search logs".',
          "Narrow the result with Kind (run, message, command, permission, guard, usage, approval, process, error) and Member.",
          "Open a result's link to see its task or its run.",
        ],
        note: "Logs is a search over past events. Search again to see newer ones. Logs is hidden from viewers.",
        actions: [
          {
            label: "Open Logs",
            to: "logs",
          },
        ],
      },
      {
        id: "decide-command",
        title: "Approve or deny a command",
        when: 'Approvals shows a count, or a run says "waiting for you". The guard asked a person before an agent runs a command.',
        steps: [
          "Open Approvals. The one that expires first is at the top.",
          "Read the command in full. The agent's reason is shown when it gave one.",
          'Press "Open run" if you need to see what led to the command.',
          'Press "Approve command" or "Deny". Your passkey is asked.',
        ],
        note: 'An approval nobody decides before its expiry becomes "expired", and the run can stop. Org admins and instance admins can decide.',
        actions: [
          {
            label: "Open Approvals",
            to: "approvals",
          },
        ],
      },
      {
        id: "control-spend",
        title: "Keep spend under control",
        when: "You want agents to cost no more than a set amount each month.",
        steps: [
          "Open Usage & budgets. See tokens and cost per agent this month. Some events have no price, so a cost can be partial.",
          "Open Policies. Under Budgets this month, set Applies to (whole organisation, team or member) and enter a Monthly limit in USD.",
          'At 80% of the limit the budget shows "near limit". Look at it on Now and in Usage & budgets.',
          "At 100% the budget is paused: its running runs are stopped and no new run starts for those agents until the next month.",
        ],
        note: "Budgets count calendar months in UTC.",
        actions: [
          {
            label: "Open Usage & budgets",
            to: "usage",
          },
          {
            label: "Open Policies",
            to: "policies",
          },
        ],
      },
      {
        id: "stop-all",
        title: "Stop everything",
        when: 'Something is wrong and you need every agent to stop now. For one run only, use "Stop run" on the Run page.',
        steps: [
          'Press "Stop all agents" in the top bar. Only instance admins see it.',
          "Confirm in the dialog, then use your passkey.",
          'Every running run is stopped and no new run starts. The top of every page shows "All agents are stopped".',
          'When it is safe, press "Resume agents" in the top bar. New runs can start again.',
        ],
        note: "Stopping does not undo work already written to a branch.",
        actions: [
          {
            label: "Open Runs",
            to: "runs",
          },
        ],
      },
    ],
  },
  {
    title: "Kinds of work",
    help: "Start-to-finish routes for common jobs. Each one runs on the board.",
    cards: [
      {
        id: "ship-feature",
        title: "Ship a feature",
        when: "You want new behaviour built by an agent in your repository.",
        steps: [
          'On Board press "New task". Write the outcome as the title and press Add.',
          "Open the task. Write the details in Description: what should work, where, and how you will check it.",
          'Set Assignee to an agent. It starts by itself, or press "Run now".',
          "Watch it under Now. Read its comments on the task and the branch name on its run.",
          'Move the task to "in review", then "done" when you have merged the branch.',
        ],
        actions: [
          {
            label: "New task on the board",
            to: "board",
          },
        ],
      },
      {
        id: "fix-bug",
        title: "Fix a bug",
        when: "Something that worked is broken and you can describe how to see it.",
        steps: [
          'On Board press "New task" and use the symptom as the title.',
          "In Description write the steps to reproduce, what you expected, what happens and any error text.",
          'Assign an agent with the right specialty, such as backend or frontend, and press "Run now".',
          "Follow the run if you want to watch. Read its comment on the task when it finishes.",
          'Ask for a test in a comment. Move the task to "done" after you check the branch.',
        ],
        actions: [
          {
            label: "New task on the board",
            to: "board",
          },
          {
            label: "Open Runs",
            to: "runs",
          },
        ],
      },
      {
        id: "review-code",
        title: "Review code",
        when: "You want a second agent to read a branch before you merge it.",
        steps: [
          'On Board press "New task". Title it "Review branch" and the branch name.',
          "In Description give the repository, the branch and what to check, such as security or missing tests.",
          "Assign an agent whose persona says it reviews and does not write code.",
          'Read the review in the task comments. Change the task to "todo" with a comment, or to "done".',
        ],
        actions: [
          {
            label: "New task on the board",
            to: "board",
          },
        ],
      },
      {
        id: "write-docs",
        title: "Write docs",
        when: "You need a README, a guide, release notes or a changelog written from the code.",
        steps: [
          "Hire or add an agent with the writing specialty if you have none.",
          'On Board press "New task" and name the document.',
          "In Description give the audience, the files to read and the path where the text must be saved.",
          "Assign the agent. Read the file on its branch and the comment it leaves on the task.",
        ],
        actions: [
          {
            label: "New task on the board",
            to: "board",
          },
          {
            label: "Hire a writing agent",
            to: "hire-writing",
          },
        ],
      },
      {
        id: "marketing",
        title: "Marketing",
        when: "You want help with marketing text, plans and web pages. Seven kinds are covered, each with what works today and what does not.",
        actions: [
          {
            label: "Open Marketing playbook",
            to: "marketing",
          },
        ],
      },
    ],
  },
];

export const MARKETING = {
  title: "Marketing",
  lead: "Agents in Harness write and plan. People do the rest. Below, each kind of marketing says what an agent can do today, what it cannot, which outside tools people normally use, and one task to start with.",
  limits: {
    title: "Harness cannot publish, send or measure results",
    body: "An agent's work stays in task comments and in files on a branch. Harness has no connection to ad accounts, analytics, search consoles, social accounts or mail senders. A person publishes, sends and reads the numbers outside Harness.",
  },
  howTitle: "How to run it here",
  how: [
    {
      title: "Hire or add a writing agent",
      body: 'Hiring, "New hire", Specialty "writing". Or Settings, Members, "Add agent" if you know the CLI. Then write its Persona (voice, audience, words to avoid) and Skills.',
    },
    {
      title: "Create tasks on the board",
      body: 'On Board press "New task", then write the brief in Description: goal, audience, length and the file path for the result. Assign the agent.',
    },
    {
      title: "Review drafts in the task and in chat",
      body: "Read the comments and the file on the branch. Ask for changes in a task comment, or mention the agent in Chat.",
    },
    {
      title: "Keep spend in Usage & budgets",
      body: "Check cost per agent there. Set a monthly budget for the writing agent in Policies.",
    },
    {
      title: "Approve risky commands",
      body: 'If a run says "waiting for you", open Approvals, read the command and press "Approve command" or "Deny".',
    },
  ],
  toolsNote: "not connected to Harness",
  taskNote:
    "The New task form has a title only. The type is a label in this guide; the server classifies each task itself. Name the type in the Description if it matters.",
};

export const MARKETING_KINDS: MarketingKind[] = [
  {
    name: "Content and blog",
    blurb: "Articles, guides and case studies for your own site.",
    can: [
      "Research a topic and list claims for you to check",
      "Outline a post and write a draft as a file",
      "Edit a draft you paste into the task",
      "Write titles, summaries and alt text",
    ],
    cannot: [
      "Publish to a site or CMS",
      "Check facts for you: a person must verify claims and sources",
      "See who reads the post",
    ],
    tools: ["WordPress", "Ghost", "Webflow"],
    task: {
      title: "Draft a 900-word post: how we review agent commands",
      type: "docs",
    },
  },
  {
    name: "SEO",
    blurb: "Titles, page copy and markup so search engines understand your pages.",
    can: [
      "Review page titles, headings and descriptions in your site's code",
      "Write new titles and meta descriptions",
      "Add structured data and fix page markup in code",
      "Suggest topics from your own pages and notes",
    ],
    cannot: [
      "Read rankings, clicks or indexing status",
      "Submit sitemaps",
      "Know which pages get search traffic",
    ],
    tools: ["Google Search Console", "Ahrefs", "Semrush"],
    task: {
      title: "Review titles and descriptions of the 10 main pages",
      type: "review",
    },
  },
  {
    name: "Email and newsletters",
    blurb: "Issues, welcome sequences and templates.",
    can: [
      "Draft a newsletter issue or a sequence of emails",
      "Write subject line options",
      "Build an HTML email template as a file",
    ],
    cannot: [
      "Send or schedule an email",
      "Import or manage a list",
      "See opens, clicks or replies",
    ],
    tools: ["Mailchimp", "Brevo", "Substack"],
    task: {
      title: "Write a 3-email welcome sequence for new sign-ups",
      type: "docs",
    },
  },
  {
    name: "Social",
    blurb: "Short posts and a plan for when to share them.",
    can: [
      "Draft posts for each network from a changelog or an article",
      "Outline a thread",
      "Write a content calendar as a table in a file",
    ],
    cannot: [
      "Post, schedule or reply",
      "Read followers, reach or comments",
      "Log in to any social account",
    ],
    tools: ["Buffer", "Hootsuite", "LinkedIn"],
    task: {
      title: "Draft two weeks of LinkedIn posts from our changelog",
      type: "docs",
    },
  },
  {
    name: "Paid ads",
    blurb: "Ad text, audiences and the landing page behind the ad.",
    can: [
      "Write headline and description variants within the limits you give",
      "Suggest keywords and audiences",
      "Write a test plan as a document",
      "Build or change the landing page in code",
    ],
    cannot: [
      "Create or change a campaign",
      "Read spend, clicks or conversions",
      "Move budget between campaigns",
    ],
    tools: ["Google Ads", "Meta Ads Manager", "LinkedIn Campaign Manager"],
    task: {
      title: "Write 10 ad headlines and 4 descriptions for the pricing page",
      type: "docs",
    },
  },
  {
    name: "Launch and product marketing",
    blurb: "Positioning, messages and the pages and notes around a release.",
    can: [
      "Draft positioning, key messages and an FAQ",
      "Write release notes",
      "Build the launch page section in code",
      "Break a launch into subtasks on the board",
    ],
    cannot: ["Announce, post or contact press or customers", "Track what happened after launch"],
    tools: ["Product Hunt", "Notion"],
    task: {
      title: "Build the launch page section for version 2.4",
      type: "feature",
    },
  },
  {
    name: "Analytics and reporting",
    blurb: "Deciding what to measure and writing it up.",
    can: [
      "Write a measurement plan: events, names and goals",
      "Add tracking code to your site",
      "Write a query or script for data you give it",
      "Summarise a CSV file you add to the repository",
    ],
    cannot: [
      "Connect to an analytics tool",
      "Read live numbers or build dashboards",
      "Tell you what happened without data you provide",
    ],
    tools: ["Google Analytics", "Plausible", "Looker Studio"],
    task: {
      title: "Research which events we should track for sign-ups",
      type: "research",
    },
  },
];
