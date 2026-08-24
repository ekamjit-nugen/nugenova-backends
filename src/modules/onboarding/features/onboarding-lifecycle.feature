Feature: Organization onboarding document lifecycle
  A super admin requests documents from a newly-provisioned organization; the
  owner submits or signs each; the super admin reviews them; and the organization
  is activated only once every document is approved.

  Scenario: a super admin requests documents from an onboarding org
    Given a super admin has provisioned an onboarding organization
    When the super admin requests an NDA and an incorporation certificate
    Then two documents are created for the organization
    And each requested document starts in the requested state

  Scenario: the owner sees the requested documents as a checklist
    Given an onboarding org has two documents requested
    When the owner opens their onboarding checklist
    Then the owner sees both requested documents
    And the onboarding summary reports none approved yet

  Scenario: the owner signs a signature document by typing their name
    Given an onboarding org with a signature document requested
    When the owner signs it with a typed signature
    Then the document moves to the submitted state
    And the stored signature records the signer name and typed method

  Scenario: the owner uploads a required document
    Given an onboarding org with an upload document requested
    And the owner has uploaded a file
    When the owner submits the upload document with that file
    Then the document moves to the submitted state

  Scenario: signing without a signer name is rejected
    Given an onboarding org with a signature document requested
    When the owner tries to sign it without a name
    Then the submission is rejected as a bad request

  Scenario: submitting an upload document without a file is rejected
    Given an onboarding org with an upload document requested
    When the owner tries to submit it without a file
    Then the submission is rejected as a bad request

  Scenario: a super admin approves a submitted document
    Given an onboarding org with a signed, submitted document
    When the super admin approves the document
    Then the document moves to the approved state

  Scenario: approving a document that is not submitted is rejected
    Given an onboarding org with a document still in the requested state
    When the super admin tries to approve that requested document
    Then the approval is rejected as a bad request

  Scenario: a rejected document is reopened for resubmission
    Given an onboarding org with a signed, submitted document
    When the super admin rejects the document with a reason
    Then the document moves to the rejected state
    And the owner can sign and resubmit it back to submitted

  Scenario: approving the last document activates the organization
    Given an onboarding org whose only document has been submitted
    When the super admin approves that final document
    Then the onboarding summary reports every document approved
    And the organization becomes active
