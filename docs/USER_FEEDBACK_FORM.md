# CoreFlow user feedback form

## Form purpose

Collect participant identity and product feedback after the CoreFlow simulation or demo. Do not collect private keys, seed phrases, passwords, or signed transaction payloads.

## Google Form setup

For a one-click setup, open [create-coreflow-feedback-form.gs](create-coreflow-feedback-form.gs) in Google Apps Script, run `createCoreFlowFeedbackForm`, approve the requested Google Forms permission, and copy the published URL from the execution log.

Create a Google Form with the title `CoreFlow 50-User Simulation Feedback` and description:

> Thank you for testing CoreFlow. This form collects your contact details, wallet address used for the demo, and product feedback. Never submit a secret key or recovery phrase.

Add these questions:

| Question | Type | Required | Validation |
|---|---|---:|---|
| Full name | Short answer | Yes | At least 2 characters |
| Email address | Short answer | Yes | Email address validation |
| Stellar wallet address | Short answer | Yes | Starts with `G`, 56 characters |
| Were you able to complete the CoreFlow workflow? | Multiple choice | Yes | Yes / Partially / No |
| Rate CoreFlow overall | Linear scale | Yes | 1 = Very poor, 5 = Excellent |
| Rate the escrow and approval flow | Linear scale | Yes | 1 = Very difficult, 5 = Very easy |
| What was the most useful feature? | Paragraph | No | Free text |
| What should we improve first? | Paragraph | Yes | Free text |
| May we contact you about your feedback? | Multiple choice | Yes | Yes / No |

In Google Forms settings, enable response collection for the email question only if the participants consent. Do not enable collection of uploaded files or sensitive credentials.

## Response reporting

Link the form to a Google Sheet and export anonymized aggregate results for the README. Include:

- response count
- average overall rating
- average escrow-flow rating
- completion percentage
- top improvement themes

Do not commit names, email addresses, or wallet addresses to this repository. Commit only aggregate statistics after consent and anonymization.

## Live form link

Add the published Google Form URL here after creating it:

`TODO: https://docs.google.com/forms/d/<FORM_ID>/viewform`
