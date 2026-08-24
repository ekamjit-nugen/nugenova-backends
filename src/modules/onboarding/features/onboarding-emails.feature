Feature: Onboarding emails
  Every step of onboarding notifies the organization by email. In dev/CI the
  outbox driver persists each email so delivery is verifiable without a mail
  server; production swaps in SMTP/ZeptoMail with the same code path.

  Scenario: requesting documents emails the owner a submission link
    Given a super admin has provisioned an onboarding organization
    When the super admin requests documents with notification enabled
    Then a documents-requested email is recorded for the organization

  Scenario: approving a non-final document emails the owner
    Given an onboarding org with two documents, one signed and submitted
    When the super admin approves that document
    Then a document-approved email is recorded for the organization

  Scenario: rejecting a document emails the owner the reason
    Given an onboarding org with a signed, submitted document
    When the super admin rejects the document with a reason
    Then a document-rejected email is recorded for the organization
