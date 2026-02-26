# Tweak

## Problem

Sometimes, users are not satisfied with a website out of the box. They want to modify behavior of the website or add a new feature.

Examples:

- Mark reddit posts as 'read'
- Automatically filter out articles that you've already read
- Remove YouTube Shorts
- Hide NSFW content
- Customize Github functionality: <https://github.com/refined-github/refined-github>
- Change the font style
- Reorder tabs in the navbar
- Reorder sections of the website

## Goal

Allow users to customize any website with a simple Englihs-language prompt.

## Solution

Build a chrome extension that allows the user

## User experience

1. Install chrome extension
2. Grant any necessary permissions. Grant all permissions up front.
3. Suggest the user pin the chrome extension
4. User types a prompt in the input box and presses Enter key or Submit button
5. The change is immediately applied to the DOM of the webpage

## Requirements

- Name the extension 'Tweak'
- Tweaks should persist forever and automatically apply to any page the user visits on this domain.
- Add a 'reset' button to clear all tweaks and return the site to its original form.
- Below the input text box, display a list of prompts sorted by active vs inactive.
  - First in the list should be all active prompts. The user can click on an active prompt to deactivate it.
  - Then, the list should display recent prompts that are inactive.

## Eng spec

- Design a simple, minimal chrome extension
- When the user submits a prompt, we will send a request to Claude Sonnet 4.6. The request should include the full content of the website DOM, the user's prompt, and a system prompt defined below.

## Tweak system prompt

"You are a browser automation expert. The user is viewing a third-party webpage and wants a visual
change applied via injected JavaScript.

Return ONLY vanilla JavaScript — no jQuery, no external libraries, no markdown, no code fences.

Rules:

- Find elements by visible text by iterating: Array.from(document.querySelectorAll('button, a, span,
  div')).find(el => el.textContent.trim() === 'Follow')
- Never use :contains() — it is not a standard CSS selector and will silently return null
- Override existing styles with: element.style.setProperty('background-color', 'green', 'important')
- If the target element is not found, throw new Error('Element not found: <description of what you
  looked for>')
- Keep the code concise and self-contained"

## Future work

Out of scope for now. Future work will include:

1. Shareable tweak links. Users can share a URL that lets others one-click apply the same tweak to a site. Content becomes the growth loop.

2. Public tweak gallery
   A browsable store of popular tweaks per site (like userstyles.org). Discovery drives installs.

A browsable store of popular tweaks per site (like userstyles.org). Discovery drives installs.
