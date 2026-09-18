Feature: Client documents — both directions, and signing only when asked
  An organization shares documents with a client, and a client can send documents
  back from their portal — including ones they want us to sign. Signing is opt-in
  in both directions: a document is only signed if someone deliberately asked for
  it, so nothing is demanded of a client by default.

  Scenario: a shared document asks for nothing unless the tick is set
    Given an organization with a client and a portal user
    When the owner shares a document without asking for a signature
    Then the client sees it with nothing to do

  Scenario: the owner asks the client to sign, and they sign it
    Given an organization with a client and a portal user
    When the owner shares a document and ticks "client must sign"
    Then the client sees it as needing their signature
    When the portal user signs it as "Rohan Kapoor"
    Then the document is signed by them
    And the signature records who signed and how

  Scenario: the tick can be turned on and off after sharing
    Given an organization with a client and a portal user
    And a shared document with no signature asked for
    When the owner ticks "client must sign"
    Then the client sees it as needing their signature
    When the owner unticks it
    Then the client sees it with nothing to do

  Scenario: a client sends us a document to sign
    Given an organization with a client and a portal user
    When the portal user sends us a document asking for our signature
    Then it appears in our queue of documents to sign
    And it is marked as having come from the client through the portal
    When the owner signs it as "Priya Nair"
    Then the document is signed
    And our queue is empty

  Scenario: a document that arrived by email is recorded for the client
    Given an organization with a client and a portal user
    When the owner records a document that the client emailed
    Then it is marked as having come from the client by email
    And the client can see it in their portal

  @security
  Scenario: a client cannot sign what was never asked of them
    Given an organization with a client and a portal user
    And a shared document with no signature asked for
    When the portal user tries to sign it
    Then the request is rejected

  @security
  Scenario: signing happens once
    Given an organization with a client and a portal user
    And a document the owner asked the client to sign
    When the portal user signs it twice
    Then the second attempt is rejected

  @security
  Scenario: a client only ever sees their own documents
    Given two clients in an organization, each sent a document, and a portal user at the first
    When that portal user lists their documents
    Then only their own client's document is listed
