Feature: Vendor documents — one way, signed only when asked
  An organization shares documents with a vendor: purchase orders, rate cards,
  policy packs. Documents flow one way — a vendor has no upload, unlike a client.
  Signing is opt-in per document: nothing is asked of a vendor unless an admin
  ticks the box, and a document signature never decides their onboarding, which
  is what agreements are for.

  Scenario: a shared document asks for nothing unless the tick is set
    Given an organization with a vendor and a portal user
    When the owner shares a document without asking for a signature
    Then the vendor sees it with nothing to do

  Scenario: the owner asks the vendor to sign, and they sign it
    Given an organization with a vendor and a portal user
    When the owner shares a document and ticks "vendor must sign"
    Then the vendor sees it as needing their signature
    When the portal user signs it as "Riya Verma"
    Then the document is signed by them

  Scenario: the tick can be turned on and off after sharing
    Given an organization with a vendor and a portal user
    And a shared document with no signature asked for
    When the owner ticks "vendor must sign"
    Then the vendor sees it as needing their signature
    When the owner unticks it
    Then the vendor sees it with nothing to do

  Scenario: signing a document does not decide onboarding
    Given an organization with a vendor and a portal user
    And a required agreement sent to that vendor
    When the owner shares a document the vendor must sign
    And the portal user signs the document
    Then the vendor is still not cleared, because the agreement is unsigned

  @security
  Scenario: a vendor cannot send us a document
    Given an organization with a vendor and a portal user
    When the portal user tries to upload a document
    Then there is no such route

  @security
  Scenario: a vendor cannot sign what was never asked of them
    Given an organization with a vendor and a portal user
    And a shared document with no signature asked for
    When the portal user tries to sign it
    Then the request is rejected

  @security
  Scenario: a vendor only ever sees their own documents
    Given two vendors in an organization, each sent a document, and a portal user at the first
    When that portal user lists their documents
    Then only their own vendor's document is listed
