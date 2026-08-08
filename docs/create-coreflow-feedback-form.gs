function createCoreFlowFeedbackForm() {
  var form = FormApp.create('CoreFlow 50-User Simulation Feedback');
  form.setDescription(
    'Thank you for testing CoreFlow. This form collects your contact details, wallet address used for the demo, and product feedback. Never submit a secret key or recovery phrase.'
  );
  form.setConfirmationMessage('Thank you. Your feedback has been recorded.');

  form.addTextItem()
    .setTitle('Full name')
    .setRequired(true);
  form.addTextItem()
    .setTitle('Email address')
    .setRequired(true);
  form.addTextItem()
    .setTitle('Stellar wallet address')
    .setHelpText('Enter the public G... wallet address used for the demo. Never enter a secret key.')
    .setRequired(true);
  form.addMultipleChoiceItem()
    .setTitle('Were you able to complete the CoreFlow workflow?')
    .setChoiceValues(['Yes', 'Partially', 'No'])
    .setRequired(true);
  form.addScaleItem()
    .setTitle('Rate CoreFlow overall')
    .setBounds(1, 5)
    .setLabels('Very poor', 'Excellent')
    .setRequired(true);
  form.addScaleItem()
    .setTitle('Rate the escrow and approval flow')
    .setBounds(1, 5)
    .setLabels('Very difficult', 'Very easy')
    .setRequired(true);
  form.addParagraphTextItem()
    .setTitle('What was the most useful feature?');
  form.addParagraphTextItem()
    .setTitle('What should we improve first?')
    .setRequired(true);
  form.addMultipleChoiceItem()
    .setTitle('May we contact you about your feedback?')
    .setChoiceValues(['Yes', 'No'])
    .setRequired(true);

  Logger.log('Edit URL: ' + form.getEditUrl());
  Logger.log('Published URL: ' + form.getPublishedUrl());
}
