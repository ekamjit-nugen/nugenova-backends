Feature: Cloud Drive
  Members organise files in a per-tenant Cloud Drive — folders, files, quotas and
  external share links. Every folder, file and share is scoped to the organization
  AND (for personal "My Drive") the caller: no user can read another org's drive,
  and plain members need an explicit access grant.

  Scenario: an org owner creates a folder and uploads a file into it
    Given an organization with an owner
    When the owner creates a team folder named "Contracts"
    And the owner uploads a file "nda.txt" into that folder
    Then the folder lists the uploaded file
    And the team overview reports one file and non-zero usage

  Scenario: a plain member without a grant is denied the drive
    Given an organization with an owner and a member
    When the member lists the team folders
    Then the request is denied with CLOUD_DRIVE_NO_ACCESS

  Scenario: an admin grants a member access and the member can then use the drive
    Given an organization with an owner and a member
    When the owner grants the member Cloud Drive access
    Then the member can list the team folders

  Scenario: personal drives are isolated between members
    Given an organization with two granted members
    When the first member creates a personal folder named "Private"
    Then the second member does not see it in their personal folders

  Scenario: an uploaded file streams back its bytes through the authenticated proxy
    Given an organization with an owner
    When the owner uploads a file "hello.txt" with contents "hello drive"
    Then downloading that file's raw bytes returns "hello drive"

  Scenario: an external share link exposes a file without a login
    Given an organization with an owner
    When the owner uploads a file "public.txt" and creates a download share for it
    Then the public share metadata reports the file name without authentication
    And the shared file can be downloaded through the public link

  Scenario: a password-protected share rejects the wrong password
    Given an organization with an owner
    When the owner uploads a file "secret.txt" and shares it with password "letmein"
    Then opening the share with the wrong password is rejected
    And opening the share with "letmein" succeeds

  Scenario: deleting a folder removes its files and revokes its shares
    Given an organization with an owner
    When the owner creates a folder, uploads a file into it, shares the file, then deletes the folder
    Then the folder no longer lists any files
    And the share for that file is revoked
