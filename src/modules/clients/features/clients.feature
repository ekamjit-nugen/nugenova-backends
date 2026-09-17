Feature: Clients — client companies, portal access, delivery teams and shared boards
  An organization manages the client companies it serves: their profile and
  contacts, the staff assigned to deliver for them, and the discussion boards
  shared with them. A contact can be promoted to a portal login (a client-role
  membership) so the client can follow the shared work and, when permitted,
  comment. Everything is org-scoped; management is owner/admin only.

  Scenario: an admin creates a client
    Given an organization
    When the owner creates a client "Acme Corp"
    Then the client is stored with status "active"
    And the client appears in the org's client list

  Scenario: duplicate company names are rejected
    Given an organization with a client "Acme Corp"
    When the owner creates a client "Acme Corp" again
    Then the create is rejected as a conflict

  @security
  Scenario: a non-admin cannot create a client
    Given an organization with an employee member
    When the employee tries to create a client "Sneaky Inc"
    Then the create is rejected as forbidden

  Scenario: an admin adds a contact and invites them to the portal
    Given an organization with a client "Acme Corp"
    When the owner adds a contact "Jane Doe" with an email
    And the owner invites that contact to the portal
    Then a client-role portal login exists for that email
    And that portal user can sign in and reach the portal overview

  Scenario: an assigned employee sees the client in "my clients"
    Given an organization with a client "Acme Corp" and an employee member
    When the owner assigns the employee to the client as "Account Manager"
    Then the employee's "my clients" list includes "Acme Corp"

  Scenario: a portal user sees a board shared with their client
    Given an organization with a client "Acme Corp" and a portal user
    And a board "Delivery Board" shared with the client with "view" permission
    When the portal user loads their overview
    Then the overview lists the board "Delivery Board"

  Scenario: a portal user can read a board shared with their client
    Given an organization with a client "Acme Corp" and a portal user
    And a board "Delivery Board" shared with the client with "view" permission
    When the portal user opens the shared board
    Then the board reads back with its title "Delivery Board"

  Scenario: a portal user with comment permission can comment
    Given an organization with a client "Acme Corp" and a portal user
    And a board "Delivery Board" shared with the client with "comment" permission
    When the portal user posts a comment "Looks great" on the board
    Then the comment is stored on the board

  @security
  Scenario: a view-only portal user cannot comment
    Given an organization with a client "Acme Corp" and a portal user
    And a board "Delivery Board" shared with the client with "view" permission
    When the portal user posts a comment "Can I edit this" on the board
    Then the comment is rejected as forbidden

  @security
  Scenario: a portal user cannot read a board not shared with their client
    Given an organization with a client "Acme Corp" and a portal user
    And a board "Private Board" that is not shared with the client
    When the portal user tries to open the unshared board
    Then the read is rejected as forbidden

  Scenario: archiving a client suspends its portal logins
    Given an organization with a client "Acme Corp" and a portal user
    When the owner archives the client
    Then the portal login is deactivated
    And the portal user is refused the portal overview

  Scenario: deleting a client cascades its shares and assignments
    Given an organization with a client "Acme Corp", an assigned employee, and a shared board
    When the owner deletes the client
    Then the client no longer appears in the client list
    And the board share and the assignment are gone

  @security
  Scenario: one organization cannot read another organization's client
    Given two separate organizations each with a client
    When the first owner tries to read the second org's client
    Then the read is rejected as not found

  Scenario: an admin sends an agreement and the client signs it
    Given an organization with a client "Acme Corp" and a portal user
    And the owner creates and sends an agreement "Mutual NDA" to the client
    When the portal user signs the agreement
    Then the agreement is recorded as signed with the signer's name
    And the owner sees the agreement as signed

  @security
  Scenario: a portal user cannot sign an agreement that was not sent
    Given an organization with a client "Acme Corp" and a portal user
    And the owner creates a draft agreement "Draft NDA" without sending it
    When the portal user tries to sign the draft agreement
    Then the sign is rejected as not found

  @security
  Scenario: a signed agreement cannot be signed again
    Given an organization with a client "Acme Corp" and a portal user
    And the owner creates and sends an agreement "Mutual NDA" to the client
    And the portal user has signed it
    When the portal user tries to sign it again
    Then the sign is rejected as a bad request

  @security
  Scenario: a role granted clients view, create and edit can manage clients but not delete them
    Given an organization with a client "Acme Corp" and a member whose role grants clients view, create and edit
    When that member lists clients and opens "Acme Corp"
    Then they see the client
    And they can create a client "Globex" and rename it "Globex Ltd"
    And they can add a contact to "Globex Ltd"
    But deleting "Globex Ltd" is forbidden

  @security
  Scenario: a member with no clients permission cannot read clients
    Given an organization with a client "Acme Corp" and an employee member
    When the employee lists clients or opens "Acme Corp"
    Then both requests are forbidden

  Scenario: a sales role can list clients to link a lead, but not open or change them
    Given an organization with a client "Acme Corp" and a member whose role grants only sales view
    When that member lists active clients
    Then "Acme Corp" is listed
    But opening or editing "Acme Corp" is forbidden
