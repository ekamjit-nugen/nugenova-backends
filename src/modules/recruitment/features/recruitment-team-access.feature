Feature: Recruitment — the team manages candidates and their CVs
  Recruiters create, read, update and delete candidates and upload CVs that are
  shown in the portal exactly as uploaded. Nothing is read out of a CV and no AI
  is involved. Access follows the recruitment permissions.

  Scenario: a recruiter manages a candidate end to end
    Given an organization with a recruiter who can view, create, edit and delete candidates
    When the recruiter creates the candidate "Neha Kapoor" with email "neha.kapoor@example.com"
    Then the candidate is listed and found by searching "kapoor"
    When the recruiter updates the candidate's company to "Acme Analytics", notice to 30 days and status to "on_hold"
    Then the profile shows the new company, notice and status
    When the recruiter deletes the candidate
    Then the candidate is gone from the list and their profile returns 404

  Scenario: a recruiter uploads CVs, replaces them with a new version and views them in the portal
    Given an organization with a recruiter who can view, create, edit and delete candidates
    And the recruiter has a candidate "Arjun Mehta"
    When the recruiter uploads "Arjun_CV_2025.pdf" as the CV
    And the recruiter uploads "Arjun_CV_2026.pdf" as a new CV
    Then the candidate has 2 CV versions with "Arjun_CV_2026.pdf" as primary
    And each CV opens in the portal with the bytes that were uploaded
    When the recruiter makes "Arjun_CV_2025.pdf" the primary CV again
    Then "Arjun_CV_2025.pdf" is the primary CV
    When the recruiter removes "Arjun_CV_2025.pdf"
    Then "Arjun_CV_2026.pdf" becomes the primary CV
    And no profile details were filled in from the CVs and no AI was used

  Scenario: a CV with unusual bytes still uploads
    Given an organization with a recruiter who can view, create, edit and delete candidates
    And the recruiter has a candidate "Anmol Sharma"
    When the recruiter uploads a CV whose content contains NUL bytes
    Then the CV is attached as primary and opens with identical bytes

  Scenario: a candidate can be created together with their CV
    Given an organization with a recruiter who can view, create, edit and delete candidates
    When the recruiter uploads "Cutshort-Priya-Nair-DE-x1.pdf" and saves "Priya Nair" with phone "9876512345" from it
    Then "Priya Nair" exists with that phone, a Cutshort source and the CV as primary

  @security
  Scenario: viewers can read and open CVs but not change anything
    Given an organization with a recruiter who can view, create, edit and delete candidates
    And the recruiter has a candidate "Arjun Mehta" with a CV
    And a teammate who can only view recruitment
    Then the viewer can list the candidate, open the profile and open the CV
    And the viewer cannot create, update, delete, upload or remove a CV

  @security
  Scenario: people outside recruitment or the organization cannot reach candidates or CVs
    Given an organization with a recruiter who can view, create, edit and delete candidates
    And the recruiter has a candidate "Arjun Mehta" with a CV
    Then an employee without recruitment access gets 403 on candidates and the CV
    And the owner of another organization gets 404 on the candidate and the CV
