Feature: Vendor portal — the vendor's own view of us
  A vendor contact can be given a login to the vendor portal, where they see the
  agreements we need signed, the people they supply us, and the bills we have
  agreed. They sign agreements themselves. They never see our drafts, they can
  never reach another vendor's rows, and they hold no staff access at all.

  Scenario: the portal is closed until someone opens it
    Given an organization with a vendor "Acme Contractors" and two contacts with emails
    When the owner tries to invite a contact
    Then the invite is refused because the portal is off
    When the owner turns the portal on
    Then both contacts are invited and emailed

  @security
  Scenario: turning the portal off locks the vendor out without deleting their login
    Given an organization with a vendor "Acme Contractors" and a portal user
    When the owner turns the portal off
    Then the portal is closed to them
    When the owner turns it back on
    Then they can use the portal again

  Scenario: inviting a contact gives them a vendor login, not a staff one
    Given an organization with a vendor "Acme Contractors" and a contact with an email
    When the owner invites that contact to the portal
    Then a vendor-role login exists for that email
    And that login is not counted as staff

  Scenario: a staff member cannot be turned into a vendor login
    Given an organization with a vendor and an employee member
    And a vendor contact carrying that employee's email
    When the owner invites that contact to the portal
    Then the invite is rejected as a conflict

  Scenario: the portal shows the vendor what we need and what we owe
    Given an organization with a vendor "Acme Contractors" and a portal user
    And a required agreement sent to that vendor
    And an approved bill of 10000 for that vendor
    When the portal user opens their portal
    Then they see 1 agreement outstanding and 10000 awaiting payment

  Scenario: the vendor signs an agreement themselves
    Given an organization with a vendor "Acme Contractors" and a portal user
    And a required agreement sent to that vendor
    When the portal user signs it as "Riya Verma"
    Then the agreement is signed by them, typed rather than recorded on their behalf
    And their portal shows nothing outstanding

  Scenario: our drafts are not the vendor's business
    Given an organization with a vendor "Acme Contractors" and a portal user
    And a draft agreement and a draft bill for that vendor
    When the portal user lists their agreements and bills
    Then both lists are empty
    And signing the draft agreement is rejected

  Scenario: the vendor keeps their own roster, but not their rates
    Given an organization with a vendor "Acme Contractors" and a portal user
    When the portal user adds "Amit Sharma" to their roster with a rate of 9999
    Then the person is added with no rate
    And the rate stays ours to set

  @security
  Scenario: a supplied contractor cannot use the vendor portal
    Given an organization with a vendor "Acme Contractors" and a portal user
    And a contractor supplied by that vendor, made a secondary member
    When that contractor tries to open the vendor portal
    Then the portal is closed to them

  @security
  Scenario: a portal user holds no staff access
    Given an organization with a vendor "Acme Contractors" and a portal user
    When the portal user tries to read the vendor list
    Then the request is rejected as forbidden
    And the team directory is closed to them too

  @security
  Scenario: a portal user reaches nothing of another vendor
    Given an organization with two vendors, each with its own bill, and a portal user at the first
    When that portal user lists their bills
    Then only their own vendor's bill is listed

  @security
  Scenario: revoking access closes the portal
    Given an organization with a vendor "Acme Contractors" and a portal user
    When the owner revokes that contact's portal access
    Then the portal is closed to them
    And the contact record is still there
