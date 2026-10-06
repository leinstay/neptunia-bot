You read {{name}}'s last few messages and find repeated devices (turns of phrase, moves, structures) that {{name}} is falling into right now.

Below: <lines> with {{name}}'s own recent messages, oldest first, numbered #1, #2, ... There may be as few as three. A line may end with (to: <a clipped version of what it answered>).

A device is a repeated way of building a reply, not a repeated topic or a word the conversation needed. Kinds: the same opener or closer across lines ("well anyway...", "...but ok" on several replies); the same tag tacked onto the end ("(no)", "...or not" every time); one sentence frame refilled with new words ("I'd call that [noun]", "that's giving [noun]"); the same kind of joke (giving the thing a name, the same comparison template, the same escalation shape); naming the hour, the time of day, the weekday, the weather or where people are as a lead-in, a frame or a punchline when it recurs across lines, even when the chat brought it up; one literal word or phrase reused as a verdict or a tag across several replies when it is not the chat's running joke (synonym swaps of the same move count as one shape).

Not a device: {{name}}'s ordinary voice (habitual swearing, lowercase, short lines are constant, not a rut), a word other people kept discussing and each reply genuinely needed (both lines mention "server" because the topic is the server and each reply is about it), a reply to the same person about the same thing in one exchange, a running joke the chat keeps alive when {{name}} only answers it. A speech act itself (admitting a mistake, agreeing, asking, disagreeing) is never a device; only its wording can be.

A word, number or phrase that {{name}} herself keeps bringing back as a callback or a tag, in three or more of these lines, especially where the line did not need it, IS a device, a stuck token, even when it came from the conversation and even when the lines are close together. The "word other people kept discussing" exclusion covers what the topic required, not {{name}}'s reused punchline. Such a device's word is the phrase itself.

A device counts when at least two lines use it; prefer ones that appear across different people or topics. A device in the newest lines matters most. With so few lines, do not stretch to fill the list: usually zero to two patterns, never more than {{maxPatterns}}. An empty list is the normal answer.

Answer with ONE bare JSON object, nothing else:

{ "patterns": [ { "shape": "", "examples": ["", ""], "count": 0, "word": "" } ] }

shape: the device in one short phrase, at most {{shapeChars}} characters, in the language the lines use. Name what the device does, not one of its wordings, so two differently phrased uses of the same move fall under one shape.
word: when the device IS a word or phrase used as a filler, tag, intensifier or sign-off, give its base form in the language of the lines (the stem or the phrase as written); empty string for a construction, a stance or a source of material.
examples: one to three short pieces copied verbatim from {{name}}'s own words (not from the (to: ...) part), each at most 80 characters.
count: how many of the lines use this device, at least 2.

Up to {{maxPatterns}} patterns, strongest first. When nothing repeats: { "patterns": [] }.

You judge nothing else: not quality, not tone, not correctness.
