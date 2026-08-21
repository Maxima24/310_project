"""Builds the CPE 310 project report as a .docx.

Formatting is fixed by the brief: Times New Roman, double line spacing, a title page, a
group members page, then the body following the department's chapter outline.

Figures come from `assets/`, produced by `make_diagrams.py` (architecture and design) and
`make_screenshots.py` (captures of the running system).

    python docs/report/make_diagrams.py
    python docs/report/make_screenshots.py      # needs the stack running
    python docs/report/build_report.py

Edit COVER and MEMBERS below and re-run to change the front matter.
"""

import os

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
OUTPUT = os.path.join(HERE, "CPE310_Project_Report.docx")

FONT = "Times New Roman"
BODY_PT = 12
CAPTION_PT = 10

# ---------------------------------------------------------------------------
# EDIT THESE, then re-run.
# ---------------------------------------------------------------------------
COVER = {
    "university": "OBAFEMI AWOLOWO UNIVERSITY",
    "faculty": "FACULTY OF COMPUTING SCIENCE",
    "department": "DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING",
    "title_line1": "DEVELOPMENT OF AN INTELLIGENT MULTI-AGENT",
    "title_line2": "CAMPUS SECURITY SURVEILLANCE SYSTEM",
    "course": "CPE 310: AGENT-BASED SYSTEMS",
    "coordinator": "DR. T.F. SHOLANKE",
    "group": "GROUP TWELVE(12), [ACADEMIC SESSION] SESSION",
    "date": "August, 2026",
}

MEMBERS = [
    ("Olatunde Ibrahim Akinade", "CSC/2022/177"),
    ("Ologunebi Tobiloba Ifeoluwa", "CSC/2022/180"),
    ("Popoola Faith", "CSC/2022/212"),
    ("Akinwamide Williams", "CSC/2022/055"),
    ("Kasali Kamil Ademola", "CSC/2022/348"),
    ("Majekodunmi Oyindamola", "CSC/2022/295"),
    ("Omidiora Ojuolape", "CSC/2022/303"),
    ("Olatunji Goodness", "CSC/2022/178"),
    ("Aderibigbe Emmanuel Semilore", "CSC/2022/029"),
    ("Adejumo Adeyinka Mosope", "CSC/2022/019"),
    ("Adeleke Semiloore Mueez", "CSC/2022/021"),
    ("Akinbode David Oluwagbemiga", "CSC/2022/053"),
    # No name was supplied for this matriculation number.
    ("[NAME MISSING]", "CSC/2023/200"),
    ("Orisasona Ayoola Williams", "CSC/2022/330"),
    ("Payne Simeon Oyelekan", "CSC/2022/357"),
    ("Odejide Oluwatunmise Benjamin", "CSC/2022/383"),
    ("Aregbesola Temiloluwa Mary", "CSC/2023/246"),
    ("Ibrahim Ramlah Adenike", "CHE/2022/017"),
]

# Measured from the repository, so the report cannot drift from the code.
STATS = {
    "hub_lines": "10,556",
    "dashboard_lines": "7,165",
    "contracts_lines": "940",
    "agent_lines": "4,603",
    "hub_tests": "355",
    "dashboard_tests": "136",
    "agent_tests": "90",
    "models": "8",
    "enums": "12",
    "migrations": "6",
}

ABBREVIATIONS = [
    ("ABAC", "Attribute-Based Access Control"),
    ("API", "Application Programming Interface"),
    ("DTO", "Data Transfer Object"),
    ("FIPA", "Foundation for Intelligent Physical Agents"),
    ("GPIO", "General Purpose Input/Output"),
    ("HTTP", "Hypertext Transfer Protocol"),
    ("JPEG", "Joint Photographic Experts Group"),
    ("JSON", "JavaScript Object Notation"),
    ("MAS", "Multi-Agent System"),
    ("MJPEG", "Motion JPEG"),
    ("MOG2", "Mixture of Gaussians, version 2"),
    ("MQTT", "Message Queuing Telemetry Transport"),
    ("ORM", "Object-Relational Mapping"),
    ("PIR", "Passive Infrared"),
    ("RBAC", "Role-Based Access Control"),
    ("REST", "Representational State Transfer"),
    ("RTSP", "Real Time Streaming Protocol"),
    ("SPA", "Single Page Application"),
    ("SQL", "Structured Query Language"),
    ("TLS", "Transport Layer Security"),
    ("TTL", "Time To Live"),
    ("UI", "User Interface"),
    ("UTC", "Coordinated Universal Time"),
]


# --------------------------------------------------------------------- styling


def set_double_spacing(target):
    """Double line spacing.

    Accepts a paragraph or a ParagraphFormat: style objects expose the format directly
    while paragraphs wrap it, and passing the wrong one is otherwise an AttributeError
    deep inside the build.
    """
    pf = getattr(target, "paragraph_format", target)
    pf.line_spacing = 2.0
    pf.space_after = Pt(0)
    pf.space_before = Pt(0)


def configure_styles(document):
    """Times New Roman everywhere, including the East Asian font slot.

    Word keeps a separate font for East Asian characters, and leaving it unset is why a
    document that looks right on one machine renders in another face elsewhere.
    """
    normal = document.styles["Normal"]
    normal.font.name = FONT
    normal.font.size = Pt(BODY_PT)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    set_double_spacing(normal.paragraph_format)

    for name, size in [("Heading 1", 14), ("Heading 2", 13), ("Heading 3", 12)]:
        style = document.styles[name]
        style.font.name = FONT
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)


def para(document, text="", *, size=BODY_PT, bold=False, italic=False,
         align=WD_ALIGN_PARAGRAPH.JUSTIFY, spacing=True, space_after=0):
    p = document.add_paragraph()
    p.alignment = align
    run = p.add_run(text)
    run.font.name = FONT
    run.font.size = Pt(size)
    run.bold = bold
    run.italic = italic
    run._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    if spacing:
        set_double_spacing(p)
    else:
        p.paragraph_format.line_spacing = 1.0
        p.paragraph_format.space_after = Pt(0)
    if space_after:
        p.paragraph_format.space_after = Pt(space_after)
    return p


def heading(document, text, level=1, toc=True):
    """A chapter or section heading.

    `toc=False` gives a visually identical heading the contents page ignores, which the
    front matter needs: a table of contents should not list itself.
    """
    if toc:
        h = document.add_heading(text, level=level)
    else:
        h = document.add_paragraph()
        h.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = h.add_run(text)
        run.bold = True
        run.font.size = Pt(14)
    for run in h.runs:
        run.font.name = FONT
        run._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    set_double_spacing(h)
    h.paragraph_format.space_before = Pt(12)
    h.paragraph_format.space_after = Pt(6)
    return h


FIGURE_NUMBER = {"n": 0}
TABLE_NUMBER = {"n": 0}


def figure(document, filename, caption, width=6.0):
    """Places a figure with a numbered caption, or a visible marker if it is missing.

    A missing image becomes a marker rather than a silent gap: a report that quietly omits
    a figure while the text still refers to it is worse than one that says so.
    """
    path = os.path.join(ASSETS, filename)
    FIGURE_NUMBER["n"] += 1

    if not os.path.exists(path):
        para(document, "[MISSING FIGURE: %s]" % filename, bold=True,
             align=WD_ALIGN_PARAGRAPH.CENTER)
        return

    holder = document.add_paragraph()
    holder.alignment = WD_ALIGN_PARAGRAPH.CENTER
    holder.paragraph_format.line_spacing = 1.0
    holder.paragraph_format.space_before = Pt(6)
    holder.paragraph_format.space_after = Pt(2)
    holder.add_run().add_picture(path, width=Inches(width))

    cap = document.add_paragraph()
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    # Captions stay single-spaced: double-spacing a one-line caption pushes it away from
    # the image it belongs to, and the brief's double spacing is about running prose.
    cap.paragraph_format.line_spacing = 1.0
    cap.paragraph_format.space_after = Pt(12)
    run = cap.add_run("Figure %d: %s" % (FIGURE_NUMBER["n"], caption))
    run.font.name = FONT
    run.font.size = Pt(CAPTION_PT)
    run.italic = True
    run._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)


def data_table(document, headers, rows, caption=None, widths=None):
    # Only a captioned table takes a number. The abbreviations list and the terms glossary
    # are reference matter rather than results, and numbering them would leave gaps in the
    # sequence the body refers to.
    if caption:
        TABLE_NUMBER["n"] += 1
        cap = document.add_paragraph()
        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cap.paragraph_format.line_spacing = 1.0
        cap.paragraph_format.space_before = Pt(8)
        cap.paragraph_format.space_after = Pt(4)
        run = cap.add_run("Table %d: %s" % (TABLE_NUMBER["n"], caption))
        run.font.name = FONT
        run.font.size = Pt(CAPTION_PT)
        run.italic = True

    table = document.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER

    for i, label in enumerate(headers):
        cell = table.rows[0].cells[i]
        cell.text = ""
        p = cell.paragraphs[0]
        p.paragraph_format.line_spacing = 1.0
        p.paragraph_format.space_after = Pt(2)
        r = p.add_run(label)
        r.bold = True
        r.font.name = FONT
        r.font.size = Pt(11)

    for values in rows:
        row = table.add_row()
        for i, value in enumerate(values):
            cell = row.cells[i]
            cell.text = ""
            p = cell.paragraphs[0]
            p.paragraph_format.line_spacing = 1.0
            p.paragraph_format.space_after = Pt(2)
            r = p.add_run(str(value))
            r.font.name = FONT
            r.font.size = Pt(11)

    if widths:
        for row in table.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Inches(w)

    document.add_paragraph().paragraph_format.space_after = Pt(8)
    return table


def bullets(document, items, numbered=False):
    for item in items:
        p = document.add_paragraph(style="List Number" if numbered else "List Bullet")
        run = p.add_run(item)
        run.font.name = FONT
        run.font.size = Pt(BODY_PT)
        run._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
        set_double_spacing(p)


def page_break(document):
    document.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def bordered_box(document, text, height_pt=150):
    table = document.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = table.cell(0, 0)
    cell.width = Inches(2.2)

    borders = OxmlElement("w:tcBorders")
    for edge in ("top", "left", "bottom", "right"):
        element = OxmlElement("w:%s" % edge)
        element.set(qn("w:val"), "dashed")
        element.set(qn("w:sz"), "8")
        element.set(qn("w:color"), "999999")
        borders.append(element)
    cell._tc.get_or_add_tcPr().append(borders)

    p = cell.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.line_spacing = 1.0
    p.paragraph_format.space_before = Pt(height_pt / 3)
    p.paragraph_format.space_after = Pt(height_pt / 3)
    run = p.add_run(text)
    run.font.name = FONT
    run.font.size = Pt(11)
    run.italic = True
    run.font.color.rgb = RGBColor(0x88, 0x88, 0x88)


def add_field(paragraph, instruction, placeholder):
    """Inserts a Word field, evaluated by Word rather than by python-docx.

    Page numbers and the table of contents must both be fields: their values depend on
    pagination, which is decided when Word lays the document out, not by whatever
    produced the XML.
    """
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = instruction
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    text = OxmlElement("w:t")
    text.text = placeholder
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for element in (begin, instr, separate, text, end):
        run._r.append(element)
    run.font.name = FONT
    run.font.size = Pt(BODY_PT)


def add_page_numbers(document):
    footer = document.sections[0].footer
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.line_spacing = 1.0
    add_field(p, "PAGE", "1")


# ------------------------------------------------------------------ front matter


def build_cover(document):
    """The title page, laid out to the department's template.

    Single-spaced, unlike the body. The brief's double spacing exists to make running
    prose readable; applying it here would push the crest and the date onto separate
    sheets.
    """
    bordered_box(document, "OAU LOGO - replace this box with the crest")
    para(document, "", spacing=False, space_after=18)

    for line in (COVER["university"], COVER["faculty"], COVER["department"]):
        para(document, line, size=13, align=WD_ALIGN_PARAGRAPH.CENTER,
             spacing=False, space_after=3)

    para(document, "", spacing=False, space_after=20)
    para(document, COVER["title_line1"], size=14, bold=True,
         align=WD_ALIGN_PARAGRAPH.CENTER, spacing=False, space_after=6)
    para(document, COVER["title_line2"], size=14, bold=True,
         align=WD_ALIGN_PARAGRAPH.CENTER, spacing=False, space_after=24)

    para(document, "A Project Report Submitted in Partial Fulfilment of the Requirements for",
         size=11, align=WD_ALIGN_PARAGRAPH.CENTER, spacing=False, space_after=3)
    para(document, COVER["course"], size=11, align=WD_ALIGN_PARAGRAPH.CENTER,
         spacing=False, space_after=3)
    para(document, "COURSE COORDINATOR:", size=11, bold=True,
         align=WD_ALIGN_PARAGRAPH.CENTER, spacing=False, space_after=14)
    para(document, COVER["coordinator"], size=11, bold=True,
         align=WD_ALIGN_PARAGRAPH.CENTER, spacing=False, space_after=20)

    para(document, "BY", size=11, align=WD_ALIGN_PARAGRAPH.CENTER,
         spacing=False, space_after=3)
    para(document, COVER["group"], size=11, bold=True,
         align=WD_ALIGN_PARAGRAPH.CENTER, spacing=False, space_after=24)
    para(document, COVER["date"], size=11, align=WD_ALIGN_PARAGRAPH.CENTER, spacing=False)


def build_members(document):
    heading(document, "GROUP MEMBERS", 1)
    para(document, "", spacing=False, space_after=8)

    table = document.add_table(rows=1, cols=3)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER

    for i, label in enumerate(["S/N", "NAME", "MATRICULATION NUMBER"]):
        cell = table.rows[0].cells[i]
        cell.text = ""
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.line_spacing = 1.0
        run = p.add_run(label)
        run.bold = True
        run.font.name = FONT
        run.font.size = Pt(BODY_PT)

    for index, (name, matric) in enumerate(MEMBERS, start=1):
        row = table.add_row()
        for i, value in enumerate([str(index), name, matric]):
            cell = row.cells[i]
            cell.text = ""
            p = cell.paragraphs[0]
            p.alignment = (WD_ALIGN_PARAGRAPH.CENTER if i != 1 else WD_ALIGN_PARAGRAPH.LEFT)
            # Eighteen members plus a header must fit the single page allotted them.
            p.paragraph_format.line_spacing = 1.0
            p.paragraph_format.space_after = Pt(2)
            run = p.add_run(value)
            run.font.name = FONT
            run.font.size = Pt(BODY_PT)


def build_abstract(document):
    s = STATS
    heading(document, "ABSTRACT", 1)
    para(document,
         "This project presents the design, implementation and evaluation of an "
         "intelligent multi-agent system for campus security surveillance. Conventional "
         "campus security depends on human patrols and closed-circuit cameras that record "
         "but do not reason: footage is reviewed after an incident rather than during "
         "one, and a sensor that has been disabled is indistinguishable from a sensor "
         "reporting nothing. The system developed here addresses both weaknesses by "
         "distributing perception across autonomous sensing agents while centralising "
         "judgement in a coordinating agent.")
    para(document,
         "Four classes of agent were implemented: motion agents using passive infrared "
         "detection, door agents using magnetic contacts, camera agents performing "
         "background-subtraction motion analysis, and a coordinating agent. Each sensing "
         "agent is autonomous and reactive, holding its own credential and detection "
         "loop, and reports only observed facts. The coordinating agent alone interprets "
         "those facts against the prevailing security posture, raises and de-duplicates "
         "alerts, detects agents that have fallen silent, enforces role-based and "
         "attribute-based access control, and maintains an audit trail of every action "
         "and every refusal.")
    para(document,
         "The system comprises approximately %s lines of coordinating logic, %s lines of "
         "interface code and %s lines of agent code, backed by a relational store of %s "
         "entities. It was evaluated through %s automated coordinator tests, %s interface "
         "tests and %s agent tests, together with four end-to-end verification programs "
         "executed against a live database and browser. Simulation across the three "
         "security postures confirmed correct alert generation, suppression of "
         "duplicates, detection of agent silence within thirty seconds, and a 137:1 "
         "reduction in stored history through hourly aggregation while preserving exact "
         "activity counts."
         % (s["hub_lines"], s["dashboard_lines"], s["agent_lines"], s["models"],
            s["hub_tests"], s["dashboard_tests"], s["agent_tests"]))
    para(document,
         "The results demonstrate that an agent-based decomposition offers concrete "
         "advantages for physical security: sensing agents may fail or be replaced "
         "independently without loss of recorded history, and centralising judgement "
         "allows policies such as refusing to disarm during an unacknowledged critical "
         "incident to be enforced uniformly, regardless of which agent reported it.")


def build_toc(document):
    heading(document, "TABLE OF CONTENTS", 1, toc=False)
    para(document, "", spacing=False, space_after=8)
    p = document.add_paragraph()
    p.paragraph_format.line_spacing = 1.5
    add_field(p, 'TOC \\o "1-3" \\h \\z \\u',
              "Right-click here and choose Update Field to generate the contents.")
    para(document, "", spacing=False, space_after=8)
    para(document,
         "(If the area above shows this instruction rather than the contents, click it, "
         "press F9, and choose to update the entire table. Word builds the list from the "
         "headings and the final pagination.)",
         size=10, italic=True, align=WD_ALIGN_PARAGRAPH.CENTER, spacing=False)


def build_abbreviations(document):
    heading(document, "LIST OF ABBREVIATIONS", 1)
    para(document, "", spacing=False, space_after=8)
    data_table(document, ["ABBREVIATION", "MEANING"], ABBREVIATIONS, widths=[1.5, 4.5])


# ------------------------------------------------------------------------ body


def chapter_one(document):
    heading(document, "1.0 INTRODUCTION", 1)

    heading(document, "1.1 Background", 2)
    para(document,
         "A university campus is an unusually difficult environment to secure. It is "
         "large, has many entrances, is occupied at irregular hours, and its population "
         "changes every session. The prevailing approach combines human patrols with "
         "closed-circuit television, and both scale badly: a guard cannot be everywhere, "
         "and camera footage is almost always reviewed after an incident rather than "
         "during it. A recording explains what happened; it does not raise an alarm.")
    para(document,
         "Multi-agent systems offer a different decomposition. Rather than one program "
         "polling every device, an agent is placed at each point of interest. Each agent "
         "is autonomous, running its own perception loop and deciding when it has "
         "something to report; reactive, responding to changes in its environment as they "
         "occur; and social, communicating through an agreed protocol rather than shared "
         "memory. This is the characterisation of agency given by Wooldridge (2009), and "
         "it maps naturally onto physical sensing, where the devices are genuinely "
         "distributed and genuinely unreliable.")

    heading(document, "1.2 Problem Statement", 2)
    para(document,
         "Existing campus surveillance arrangements exhibit four specific weaknesses that "
         "this project addresses.")
    bullets(document, [
        "Monitoring does not scale with the number of sensors. Human attention is the "
        "bottleneck, and adding cameras worsens the problem rather than easing it.",
        "A disabled sensor is invisible. Systems report what their sensors detect, so a "
        "sensor that has been unplugged, obscured or cut simply reports nothing, which "
        "is indistinguishable from a quiet corridor.",
        "Context is ignored. A door opening at midday during an examination is routine; "
        "the same door opening at midnight is not. Systems treating every detection "
        "identically generate alarms nobody trusts.",
        "There is no accountability. Where an operator can silence an alarm, there is "
        "frequently no record of who did so, when, or whether it was investigated first.",
    ])

    heading(document, "1.3 Aim and Objectives", 2)
    para(document,
         "The aim of this project is to develop an intelligent multi-agent system for "
         "campus security surveillance in which distributed autonomous agents perform "
         "perception while a coordinating agent performs judgement, alerting and record "
         "keeping. The specific objectives are:")
    bullets(document, [
        "To design an agent-based architecture in which sensing agents and the "
        "coordinating agent can fail independently without loss of recorded history.",
        "To implement autonomous motion, door and camera agents capable of operating in "
        "both simulated and physical modes.",
        "To develop decision logic interpreting observations against the prevailing "
        "security posture rather than in isolation.",
        "To detect agent silence as a first-class security event, so that tampering is "
        "reported rather than merely producing an absence of alarms.",
        "To enforce role-based and attribute-based access control such that dangerous "
        "operations are refused, with the reason recorded.",
        "To evaluate the system by simulation across defined scenarios and by automated "
        "testing against live infrastructure.",
    ], numbered=True)

    heading(document, "1.4 Scope of the Project", 2)
    para(document,
         "The project covers agent design and implementation, the communication protocol "
         "between agents, the decision logic of the coordinating agent, persistence of "
         "observations and judgements, the operator interface, and evaluation by "
         "simulation. Physical access control such as electronic door locking is outside "
         "the scope, as are biometric identification and off-campus monitoring. Video is "
         "used for motion detection and live viewing but not for face or object "
         "recognition.")
    para(document,
         "Where a capability is partially realised, notably the hardware drivers for "
         "physical infrared and magnetic sensors, this is stated explicitly in Section "
         "5.3 rather than presented as complete.")

    heading(document, "1.5 Significance of the Project", 2)
    para(document,
         "The significance of the work is threefold. Practically, it demonstrates that a "
         "credible campus surveillance system can be assembled from inexpensive "
         "components, a single-board computer or microcontroller per sensing point, "
         "coordinated by software rather than by a proprietary alarm panel. Academically, "
         "it provides a concrete case study in agent-oriented decomposition where the "
         "agents are genuinely distributed and genuinely fallible, which is a more "
         "demanding setting than a purely software simulation.")
    para(document,
         "Methodologically, the project illustrates that treating silence as information "
         "and refusal as a recordable event materially changes what a security system can "
         "be trusted to tell its operators.")

    heading(document, "1.6 Definition of Terms", 2)
    data_table(document, ["TERM", "DEFINITION"], [
        ("Agent", "An autonomous computational entity that perceives its environment and "
                  "acts upon it, deciding for itself when to act."),
        ("Multi-Agent System", "A system of several interacting agents that together "
                               "achieve an objective no single agent addresses alone."),
        ("Autonomy", "The capacity to operate without direct intervention, controlling "
                     "one's own internal state and actions."),
        ("Reactivity", "The capacity to perceive a change in the environment and respond "
                       "to it in a timely fashion."),
        ("Coordinating agent", "The agent receiving observations from sensing agents, "
                               "interpreting them, and holding shared state."),
        ("Event", "A reported observation of fact, such as a door opening. Carries no "
                  "judgement about significance."),
        ("Alert", "A judgement by the coordinating agent that an event, in the prevailing "
                  "context, requires human attention."),
        ("Security posture", "The state of the monitored environment: disarmed, home or "
                             "away. Also termed the arm mode."),
        ("Heartbeat", "A periodic liveness message by which an agent demonstrates it is "
                      "still operating."),
        ("Rollup", "An hourly aggregate of event counts retained after the underlying "
                   "individual events are deleted."),
        ("Audit trail", "An append-only record of actions attempted, including those "
                        "refused, and the reason for refusal."),
    ], widths=[1.8, 4.2])


def chapter_two(document):
    heading(document, "2.0 LITERATURE REVIEW", 1)

    heading(document, "2.1 Preamble", 2)
    para(document,
         "This chapter reviews the concepts underpinning agent-based systems, examines "
         "categories of existing surveillance technology, and compares them against the "
         "requirements identified in Chapter One. Its purpose is to establish why an "
         "agent-oriented decomposition was selected rather than a conventional "
         "centralised design.")

    heading(document, "2.2 Conceptual Review", 2)
    para(document,
         "Wooldridge (2009) characterises an agent as a computer system situated in an "
         "environment and capable of autonomous action within it in order to meet its "
         "objectives. Four properties are commonly attributed to agents: autonomy, "
         "reactivity, pro-activeness and social ability. Russell and Norvig (2021) frame "
         "the same idea as an agent function mapping percept histories to actions, and "
         "distinguish simple reflex agents from model-based and goal-based ones.")
    para(document,
         "The sensing agents in this project are best classified as reflex agents with "
         "internal state. A motion agent maintains enough state to know whether its "
         "detector was previously active and when it last reported, which is what allows "
         "it to report a rising edge rather than a continuous condition, but it holds no "
         "model of the building. The coordinating agent is model-based: it maintains the "
         "security posture, the set of known agents and the outstanding alerts, and its "
         "response to an identical percept differs according to that model.")
    para(document,
         "Coordination between agents may be organised in several ways. Direct "
         "peer-to-peer negotiation, formalised in the FIPA agent communication "
         "specifications, suits agents that must bargain over resources. A mediated "
         "arrangement, where agents communicate through a coordinator, suits systems "
         "requiring a consistent global judgement. The latter was adopted here for the "
         "reason developed in Section 3.2: a security decision must be consistent, and "
         "consistency is far simpler to guarantee when a single agent holds the "
         "authoritative state.")

    heading(document, "2.3 Review of Related Works", 2)
    para(document,
         "Conventional intruder alarm panels connect sensors to a central controller over "
         "dedicated wiring, partitioning them into zones. They are reliable and simple, "
         "but closed: adding a new class of sensor requires new hardware, the panel "
         "retains only a short event log, and the intelligence is fixed at manufacture.")
    para(document,
         "Networked video surveillance systems address the visual dimension well, "
         "offering recording, retention and remote viewing. They typically treat "
         "non-video sensors as peripheral, provide limited contextual reasoning, and "
         "increasingly depend on a vendor cloud service, introducing both a privacy "
         "consideration and a dependency on external connectivity.")
    para(document,
         "Research systems applying multi-agent techniques to surveillance have "
         "demonstrated distributed detection and cooperative tracking, and establish that "
         "agent decomposition suits the domain. They are, however, usually evaluated "
         "purely in simulation, and questions of credential management, tamper detection "
         "and auditability, which dominate a deployed system, receive comparatively "
         "little attention.")

    heading(document, "2.4 Comparison of Related Works", 2)
    data_table(document, ["Criterion", "Alarm panel", "IP video", "MAS research",
                          "This project"], [
        ("Distributed autonomy", "No", "Partial", "Yes", "Yes"),
        ("Context-aware alerting", "Zone only", "Limited", "Varies", "Yes"),
        ("Tamper / silence detection", "Wire fault", "Rare", "Rare", "Yes"),
        ("Extensible sensor types", "No", "Limited", "Yes", "Yes"),
        ("Per-agent credentials", "No", "Rare", "Rare", "Yes"),
        ("Audit of refused actions", "No", "No", "No", "Yes"),
        ("Operates without cloud", "Yes", "Often not", "Yes", "Yes"),
        ("Deployed and measured", "Yes", "Yes", "Rarely", "Yes"),
    ], caption="Comparison of surveillance approaches against project requirements.",
        widths=[1.8, 1.1, 1.0, 1.1, 1.0])
    para(document,
         "The comparison indicates that no single existing category satisfies all four "
         "weaknesses identified in Section 1.2 simultaneously. Alarm panels detect wire "
         "faults but cannot reason about context; video systems see but do not judge; and "
         "research multi-agent systems reason well but are seldom evaluated under the "
         "operational concerns of credentials and accountability.")


def chapter_three(document):
    s = STATS
    heading(document, "3.0 SYSTEM DESIGN", 1)

    heading(document, "3.1 Preamble", 2)
    para(document,
         "This chapter presents the design of the system: the methodology followed, the "
         "requirements established, the roles identified, the resulting agent "
         "architecture, the interaction protocol, and the decision logic of the "
         "coordinating agent.")

    heading(document, "3.2 Design Methodology Adopted", 2)
    para(document,
         "An agent-oriented analysis was followed, in the spirit of the Gaia methodology "
         "of Wooldridge, Jennings and Kinny (2000), which proceeds from roles to "
         "interactions to concrete agent types. Rather than beginning with the devices "
         "available, the analysis began by asking what roles the system must fill "
         "(sensing, judging, notifying, recording, scheduling and presenting) and only "
         "then assigning those roles to agents. This ordering produced the project's "
         "central design decision, and would not have emerged from a device-first "
         "analysis.")
    para(document,
         "THE SEPARATION OF OBSERVATION FROM JUDGEMENT. A sensing agent reports only "
         "facts: a pin changed state, a contour of a given area was detected. It never "
         "decides whether that constitutes an intrusion, because it cannot: it does not "
         "know the security posture, what has already been reported, or whether a human "
         "has already responded. Judgement belongs exclusively to the coordinating agent. "
         "This allows a sensing agent to remain simple, cheap, replaceable and only "
         "partially trusted, while the system as a whole reasons coherently.")
    para(document,
         "Development proceeded iteratively, each iteration delivering a working system: "
         "sensing agents and ingestion first, then alert logic, then access control, then "
         "live video, and finally retention, auditing and scheduling.")

    heading(document, "3.3 Requirements Analysis", 2)
    para(document, "Functional requirements were established as follows.")
    bullets(document, [
        "The system shall accept observations from distributed sensing agents over a "
        "network protocol, authenticating each agent individually.",
        "The system shall interpret each observation against the prevailing security "
        "posture and raise an alert where warranted.",
        "The system shall suppress duplicate alerts arising from a single ongoing "
        "condition.",
        "The system shall detect and report the failure or silence of any sensing agent.",
        "The system shall provide live video from camera agents on demand.",
        "The system shall allow the security posture to be changed manually and on a "
        "schedule.",
        "The system shall record all operator actions, including refused ones.",
        "The system shall retain a summarised history after detailed records are "
        "discarded.",
    ])
    para(document, "Non-functional requirements were as follows.")
    bullets(document, [
        "Agent failure shall not cause loss of previously recorded history.",
        "A compromised sensing agent shall not be able to act as any other agent.",
        "Detection of agent silence shall occur within approximately thirty seconds.",
        "The operator interface shall explain refusals in terms an operator can act on.",
        "The system shall operate wholly on a local network, without dependence on an "
        "external service.",
    ])

    heading(document, "3.3.4 Hardware Specifications", 3)
    para(document,
         "The system was designed to run on inexpensive and widely available hardware. "
         "Each sensing point requires only a processor capable of network communication "
         "and the sensor itself.")
    data_table(document, ["Component", "Specification", "Role"], [
        ("Coordinating host", "x86-64 or ARM machine, 4 GB RAM, Docker",
         "Hosts coordinating agent, database and interface"),
        ("Sensing node (Linux)", "Raspberry Pi Zero 2 W or Pi 4, 40-pin GPIO",
         "Hosts motion and door agents"),
        ("Sensing node (MCU)", "ESP32-S3, 2.4 GHz Wi-Fi, MicroPython",
         "Low-cost alternative sensing node"),
        ("Motion sensor", "HC-SR501 passive infrared, 5 V supply, 3.3 V output",
         "Detects movement within approximately 7 m"),
        ("Door sensor", "Magnetic reed switch, normally open or closed",
         "Detects opening and closing of a door"),
        ("Camera", "USB webcam at 640x480 or above, or RTSP camera",
         "Video for motion analysis and live viewing"),
    ], caption="Hardware specification per sensing point.", widths=[1.5, 2.4, 2.1])

    heading(document, "3.4 Role Analysis", 2)
    para(document,
         "Following the methodology, roles were identified before agents. Six roles were "
         "established, together with the permissions each requires. Roles do not map "
         "one-to-one onto agents: the coordinating agent fills several, while the sensing "
         "role is filled by many agents.")
    data_table(document, ["Role", "Responsibility", "Filled by"], [
        ("Sensor", "Perceive a physical condition and report it as fact",
         "Motion, door and camera agents"),
        ("Adjudicator", "Interpret observations against posture; raise or suppress alerts",
         "Coordinating agent"),
        ("Invigilator", "Detect and report agents that have fallen silent",
         "Coordinating agent"),
        ("Notifier", "Deliver alerts through external channels", "Coordinating agent"),
        ("Custodian", "Summarise and prune history; maintain the audit trail",
         "Coordinating agent"),
        ("Operator", "Acknowledge alerts and set the security posture",
         "Human, through the interface"),
    ], caption="Role analysis and assignment to agents.", widths=[1.3, 3.1, 1.6])
    figure(document, "fig04_permissions.png",
           "The permission set associated with each role. A sensing agent holds only what "
           "sensing requires, and never the ability to acknowledge the alert its own "
           "tampering would raise.")

    heading(document, "3.5 System Architecture", 2)
    para(document,
         "The resulting architecture places autonomous sensing agents at the edge, "
         "communicating over HTTP or MQTT with a coordinating agent that owns all shared "
         "state. The coordinating agent persists observations and judgements to a "
         "relational database, broadcasts changes to connected interfaces, and exposes "
         "the whole through a single network origin.")
    figure(document, "fig01_architecture.png",
           "System architecture. Sensing agents report to the coordinating agent, which "
           "owns judgement, persistence and access control.")
    para(document,
         "The implementation is organised as a single repository with four components so "
         "that the communication contract is shared rather than duplicated: a renamed "
         "field becomes a compilation error rather than a silently broken interface. The "
         "coordinating agent comprises approximately %s lines, the operator interface %s "
         "lines, the sensing agents %s lines, and the shared contract %s lines."
         % (s["hub_lines"], s["dashboard_lines"], s["agent_lines"], s["contracts_lines"]))
    figure(document, "fig07_deployment.png",
           "Deployment topology. A reverse proxy presents the interface, the programming "
           "interface and the live video channel as a single origin.")
    para(document,
         "Persistent state is held in %s entities across %s enumerated types, evolved "
         "through %s schema migrations. Two design decisions are significant. An "
         "observation records the coordinating agent's own arrival time separately from "
         "the sensing agent's reported time, so ordering survives an agent with an "
         "incorrect clock. An alert retains its own description and severity rather than "
         "depending on the observation that caused it, which is why discarding old "
         "observations cannot destroy the record of a judgement."
         % (s["models"], s["enums"], s["migrations"]))
    figure(document, "fig03_data_model.png",
           "Entity relationships. Alerts outlive the observations that produced them, and "
           "hourly aggregates outlive both.")

    heading(document, "3.6 Agent Specifications", 2)
    para(document,
         "Each agent type is specified below in terms of its percepts, internal state and "
         "available actions. All sensing agents share a common lifecycle: enrol, obtain a "
         "credential, then loop, perceiving, deciding whether the percept is reportable, "
         "reporting, and periodically signalling liveness.")
    data_table(document, ["Agent", "Percepts", "Internal state", "Actions"], [
        ("Motion agent", "Infrared detector level",
         "Previous level; last report time", "Report motion; heartbeat"),
        ("Door agent", "Magnetic contact continuity",
         "Debounced contact state", "Report opening or closing; heartbeat"),
        ("Camera agent", "Video frames",
         "Background model; cooldown", "Report motion; publish frame; record clip"),
        ("Coordinating agent", "Reports from agents; operator commands",
         "Posture; agent registry; open alerts",
         "Raise, suppress or refuse; notify; broadcast; record"),
    ], caption="Agent specifications.", widths=[1.2, 1.6, 1.5, 1.7])
    para(document,
         "The camera agent is the most computationally involved. It applies a "
         "mixture-of-Gaussians background subtraction model to each frame, removes shadow "
         "pixels, applies a morphological opening so that one genuine subject does not "
         "fragment into several sub-threshold regions, and reports only when the "
         "resulting contour area exceeds a configured threshold. The first thirty frames "
         "are discarded while the background model converges; without this, every camera "
         "agent reports motion at the instant it starts.")

    heading(document, "3.7 Interaction Design", 2)
    para(document,
         "Interaction between sensing agents and the coordinating agent is deliberately "
         "minimal, consisting of three message types. This economy allows the same "
         "protocol to be spoken by a Python process on a computer, a Raspberry Pi, an "
         "ESP32 microcontroller and a web browser.")
    data_table(document, ["Message", "Direction", "Content", "Purpose"], [
        ("Enrol", "Agent to coordinator", "Identity, type, location",
         "Register and obtain a credential"),
        ("Heartbeat", "Agent to coordinator", "Agent identity",
         "Demonstrate continued liveness"),
        ("Report", "Agent to coordinator", "Identity, type, timestamp, detail",
         "Communicate an observation"),
        ("Frame", "Camera to coordinator", "Encoded image",
         "Supply video for live viewing"),
        ("Broadcast", "Coordinator to interface", "Event, alert, posture or agent change",
         "Update operators in real time"),
    ], caption="Message catalogue. Appendix B gives the complete specification.",
        widths=[0.9, 1.5, 1.9, 1.7])
    figure(document, "fig02_event_flow.png",
           "Interaction sequence for a single observation, from perception to operator "
           "display.")
    para(document,
         "An observation is persisted BEFORE it is judged. This ordering matters: it "
         "guarantees the factual record survives a change to the judgement rules, or a "
         "failure of the coordinating agent part-way through a decision. What was "
         "observed and what was concluded are separable records, and only the latter is a "
         "matter of policy.")

    heading(document, "3.8 Detailed Design of the Decision Logic", 2)
    para(document,
         "The coordinating agent's decision logic comprises four mechanisms: alert "
         "adjudication, duplicate suppression, liveness invigilation and access control.")

    heading(document, "3.8.1 Alert Adjudication", 3)
    para(document,
         "Whether an observation becomes an alert depends on the security posture at the "
         "moment it arrives. Under DISARMED no alert is raised; under HOME only perimeter "
         "agents are armed, permitting movement inside while entry is still detected; "
         "under AWAY every agent is armed. The posture in force is recorded on the alert "
         "itself, so the reason the alert exists is never lost.")
    figure(document, "fig05_alert_rules.png",
           "Alert adjudication. The posture at the moment of observation is recorded on "
           "the resulting alert.")

    heading(document, "3.8.2 Duplicate Suppression", 3)
    para(document,
         "A single ongoing condition, such as a person moving along a corridor or a "
         "propped door, produces repeated observations. Raising an alert for each would "
         "bury everything else. A further alert of the same type from the same agent is "
         "therefore suppressed while an earlier matching alert remains unacknowledged. "
         "The interface additionally groups such alerts into a single row bearing a "
         "count, so that twenty repetitions of one problem present as one decision.")

    heading(document, "3.8.3 Liveness Invigilation", 3)
    para(document,
         "An agent cannot report its own failure: an agent that has been unplugged or "
         "obstructed does not send a message announcing it. The coordinating agent "
         "therefore determines liveness itself, periodically identifying agents whose "
         "last heartbeat exceeds the tolerated interval and raising an alert on their "
         "behalf. A grace period after coordinator startup prevents a restart from "
         "declaring the entire healthy population compromised.")
    figure(document, "fig08_liveness.png",
           "Liveness state transitions. Silence is treated as evidence, because it is the "
           "only signal a disabled agent can produce.")

    heading(document, "3.8.4 Access Control", 3)
    para(document,
         "Access control operates at two levels. Role-based control determines what a "
         "class of user may do at all, guarding each operation on a specific permission "
         "rather than on a role, so that changing a role's capabilities never requires "
         "modifying an operation. An operation declaring no permission is refused to "
         "everyone, meaning an omission fails closed.")
    para(document,
         "Attribute-based control determines whether a permitted action may be performed "
         "in the present circumstances. The principal rule is that DISARMING WHILE A "
         "CRITICAL ALERT REMAINS UNACKNOWLEDGED REQUIRES ELEVATED AUTHORITY. The "
         "situation this prevents is realistic: an alarm is sounding, and the fastest way "
         "to stop it is to disarm rather than investigate, which is precisely what an "
         "intruder reaching the panel would do. Acknowledging the alert first is the "
         "intended path, and doing so permits disarming.")
    figure(document, "shot03_mode_control.png",
           "The posture control refusing a disarm request and explaining the reason in "
           "terms the operator can act upon.")

    heading(document, "3.10 Design Tools", 2)
    data_table(document, ["Tool", "Purpose"], [
        ("NestJS (TypeScript)", "Coordinating agent framework"),
        ("PostgreSQL with Prisma", "Persistent store and schema migration"),
        ("React with Vite", "Operator interface"),
        ("Python with OpenCV", "Sensing agents and video analysis"),
        ("MicroPython", "Microcontroller sensing node firmware"),
        ("Docker Compose", "Simulation environment and deployment"),
        ("MQTT (Mosquitto)", "Alternative agent transport"),
        ("Jest, Vitest, pytest", "Automated testing of each component"),
        ("Playwright", "Automated interface verification and capture"),
    ], caption="Tools used and their purpose.", widths=[2.2, 3.8])


def chapter_four(document):
    s = STATS
    heading(document, "4.0 SIMULATION AND RESULTS", 1)

    heading(document, "4.1 Preamble", 2)
    para(document,
         "This chapter describes how the system was evaluated: the simulation platform "
         "adopted, the environment modelled, the scenarios executed, the results "
         "obtained, and what those results indicate about the design.")

    heading(document, "4.2 Simulation Platform and Justification", 2)
    para(document,
         "Evaluation was conducted using the complete implemented system with its sensing "
         "agents operating in simulation mode, rather than in a dedicated agent "
         "simulation toolkit. This choice deserves justification.")
    para(document,
         "A toolkit such as JADE or NetLogo would model agent interaction faithfully "
         "while abstracting away the concerns that dominate a deployed security system: "
         "credential handling, partial failure, clock disagreement, network interruption "
         "and database behaviour. Because every agent here communicates over an ordinary "
         "network protocol, substituting a simulated detector for a physical one leaves "
         "the entire remainder of the system genuinely exercised. The agents, the "
         "protocol, the coordinating logic, the persistence and the interface are the "
         "real implementations; only the physical stimulus is synthetic.")
    para(document,
         "Each sensing agent accordingly provides two interchangeable detector "
         "implementations behind a common interface. The simulated detector produces "
         "activity stochastically at a configurable rate; the physical detector reads a "
         "hardware input. The agent itself cannot distinguish them, which makes the "
         "simulation evidence about the deployed system rather than about a model of it.")

    heading(document, "4.3 Simulation Architecture", 2)
    para(document,
         "The simulation runs as a set of containers on a single host: the coordinating "
         "agent, the database, the object store for recorded video, the message broker, "
         "an electronic mail sink for notification testing, the reverse proxy, and one "
         "container per sensing agent. Each sensing agent enrols independently on startup "
         "and thereafter behaves exactly as a physically distributed agent would. The "
         "topology is that of Figure 7: the containers communicate only over the network, "
         "exactly as physically dispersed agents would.")

    heading(document, "4.4 Environment Model", 2)
    para(document,
         "The modelled environment represents a small campus building with three "
         "monitored points and three security postures.")
    data_table(document, ["Parameter", "Value", "Rationale"], [
        ("Monitored points", "Hallway, Front door, Lobby", "One of each agent type"),
        ("Motion probability", "0.05 per poll cycle", "Intermittent, irregular activity"),
        ("Door open probability", "0.03 per poll cycle", "Doors used less than corridors"),
        ("Poll interval", "2 seconds", "Balances responsiveness against load"),
        ("Heartbeat interval", "10 seconds", "Three missed beats indicates failure"),
        ("Silence tolerance", "30 seconds", "Detection within one sweep thereafter"),
        ("Alert cooldown", "60 seconds", "Suppresses repeats of one condition"),
        ("Camera frame rate", "5 per second at 640x480", "Sufficient to detect and view"),
    ], caption="Environment model parameters.", widths=[1.6, 1.9, 2.5])
    para(document,
         "A synthetic camera agent was additionally implemented to provide a "
         "deterministic video source: it renders a moving indicator and a running clock, "
         "so a stalled feed is immediately distinguishable from a static scene. This was "
         "necessary because a simulated camera agent produces no imagery at all, and a "
         "still photograph of an empty room cannot demonstrate that video is live.")

    heading(document, "4.5 Implementation of Agents", 2)
    para(document,
         "All four agent types were implemented and executed. The sensing agents comprise "
         "approximately %s lines of Python, sharing a common transport, contract and "
         "lifecycle, and differing only in their detector and the observation type they "
         "report. Firmware for a microcontroller sensing node was additionally "
         "implemented in MicroPython, structured so its decision logic, debouncing, "
         "cooldown, retry and credential persistence, is testable independently of the "
         "hardware." % s["agent_lines"])
    figure(document, "shot06_agents.png",
           "The agent registry during simulation, showing type, location, liveness and "
           "time since last contact for each enrolled agent.")

    heading(document, "4.6 Test Scenarios", 2)
    para(document, "Eight scenarios were defined to exercise the decision logic.")
    data_table(document, ["No.", "Scenario", "Expected outcome"], [
        ("1", "Motion observed while disarmed", "Observation recorded, no alert"),
        ("2", "Motion observed while away", "Critical alert raised"),
        ("3", "Interior motion while home", "Observation recorded, no alert"),
        ("4", "Door opened while away", "Critical alert raised"),
        ("5", "Repeated motion within cooldown", "Single alert, repeats suppressed"),
        ("6", "Agent stops sending heartbeats", "Agent marked offline, alert raised"),
        ("7", "Disarm attempted with critical alert open",
         "Refused with reason, refusal recorded"),
        ("8", "Scheduled posture change at boundary", "Posture changed once, recorded"),
    ], caption="Simulation scenarios and expected outcomes.", widths=[0.5, 2.7, 2.8])

    heading(document, "4.7 Results", 2)
    para(document,
         "All eight scenarios produced their expected outcomes. The figures below are "
         "captures of the running system during evaluation.")
    figure(document, "shot02_overview.png",
           "The operator interface during simulation. Security posture, agent population, "
           "outstanding alerts, live video and recent activity appear together. Note the "
           "refusal notice: disarming is locked while critical alerts remain "
           "unacknowledged, demonstrating Scenario 7.")
    figure(document, "shot05_stats.png",
           "Aggregate counters during simulation: agents enrolled, alerts outstanding, "
           "those judged critical, and observations in the preceding hour.")
    figure(document, "shot04_alerts.png",
           "Alert presentation, demonstrating Scenario 5. Repetitions of one condition "
           "collapse into a single counted entry that may be acknowledged together.")
    figure(document, "shot07_events.png",
           "The observation stream, showing raw reports from all agents before "
           "adjudication.")
    para(document,
         "Live video from camera agents was verified end to end. The measured frame rate "
         "is displayed alongside each feed rather than the configured rate, which allows "
         "a degraded feed to be diagnosed rather than merely suspected.")
    figure(document, "shot08_cameras.png",
           "Live video from camera agents. Feeds begin automatically and are limited in "
           "number, since each open stream occupies a network connection for its "
           "duration.")
    figure(document, "shot09_camera_tile.png",
           "An individual camera feed showing the measured frame rate and resolution.")
    para(document,
         "Automated testing accompanied the simulation. The coordinating agent carries %s "
         "tests, the interface %s, and the sensing agents %s, all passing. Four "
         "end-to-end verification programs additionally exercise the implemented system "
         "against a live database and a live browser rather than against substitutes."
         % (s["hub_tests"], s["dashboard_tests"], s["agent_tests"]))
    data_table(document, ["Verification", "Assertions", "Property established"], [
        ("Retention", "17 of 17", "Aggregation exact; unacknowledged alerts survive"),
        ("Audit", "33 of 33", "Refusals recorded; trail read-only and admin-only"),
        ("Scheduling", "23 of 23", "Fires once; held during incident; stale boundary skipped"),
        ("Camera provisioning", "32 of 32", "Video sources cannot be disguised as hardware"),
    ], caption="End-to-end verification results.", widths=[1.6, 1.1, 3.3])
    para(document,
         "History aggregation was measured on accumulated simulation data. A total of "
         "9,727 individual observations were reduced to 71 hourly aggregate records, a "
         "ratio of approximately 137 to 1, while remaining exact for the questions "
         "historical review actually poses.")
    figure(document, "fig06_retention.png",
           "History aggregation. An observation is never discarded before its hour has "
           "been counted, and an unacknowledged alert is never discarded at any age.")
    figure(document, "shot10_reports.png",
           "Aggregated history over a thirty-day window, by agent, by observation type "
           "and by alert severity.")
    figure(document, "shot11_activity_chart.png",
           "Daily activity during evaluation. Alerts are overlaid on observations rather "
           "than charted separately, since the question is whether activity became alarm.")
    para(document,
         "Access control was verified by exercising the system under each class of "
         "credential. Every restriction is enforced by the coordinating agent "
         "independently of the interface: invoking the programming interface directly "
         "produces the same refusal.")
    figure(document, "shot18_viewer_overview.png",
           "The same interface under a read-only credential. Posture controls and "
           "acknowledgement actions are absent.")
    figure(document, "shot19_viewer_settings.png",
           "Settings under a read-only credential. The audit trail is described but "
           "withheld, rather than concealed entirely.")
    figure(document, "shot15_settings_admin.png",
           "Settings under an administrative credential, with the audit trail available.")
    figure(document, "shot16_audit.png",
           "The audit trail. The verified role and the self-asserted name are presented "
           "differently, because they are different kinds of fact.")
    figure(document, "shot13_schedules.png",
           "Scheduled posture changes, demonstrating Scenario 8. Each schedule stores its "
           "own time zone so it remains correct across seasonal clock changes.")
    figure(document, "shot17_cameras_admin.png",
           "Camera provisioning under an administrative credential.")
    figure(document, "shot01_signin.png",
           "Credential entry. The credential determines the role; the optional name is "
           "recorded as an unverified claim, and the interface states this.")

    heading(document, "4.8 Discussion of Results", 2)
    para(document,
         "The results support the design decisions taken in Chapter Three. Separating "
         "observation from judgement proved valuable in practice as well as in principle: "
         "because sensing agents hold no policy, the adjudication rules were revised "
         "several times during development without altering, redeploying or even "
         "restarting a single agent.")
    para(document,
         "Treating silence as information proved similarly worthwhile. Scenario 6 "
         "confirmed that an agent ceasing to communicate is reported within the expected "
         "interval, and the startup grace period was found to be necessary rather than "
         "merely prudent: without it, restarting the coordinating agent caused every "
         "healthy agent to be declared compromised simultaneously, precisely the kind of "
         "false alarm that teaches operators to disregard alerts.")
    para(document,
         "The verification programs proved more valuable than the unit tests in one "
         "instructive respect. The scheduled posture change feature passed the entirety "
         "of its unit test suite while being completely inert. The query used to claim a "
         "schedule excluded records whose last-fired value was null, which is every "
         "schedule that has never fired; in SQL a comparison against null yields neither "
         "true nor false, and a substituted database cannot reproduce that behaviour. "
         "Only execution against the real database revealed that no schedule would ever "
         "have activated. The lesson generalises: passing tests establish that code does "
         "what its author expected, not that the expectation was correct.")
    para(document,
         "The measured 137 to 1 aggregation ratio indicates that indefinite retention of "
         "individual observations is unnecessary for the questions historical review "
         "poses. It also clarified an ordering constraint that was not obvious in "
         "advance: an observation must never be discarded before its hour has been "
         "counted, since the reverse ordering does not compress history but destroys it.")


def chapter_five(document):
    heading(document, "5.0 CONCLUSION AND RECOMMENDATIONS", 1)

    heading(document, "5.1 Summary of Work Done", 2)
    para(document,
         "An intelligent multi-agent system for campus security surveillance was "
         "designed, implemented and evaluated. Role analysis identified six roles, "
         "assigned to four agent types: motion, door and camera sensing agents, and a "
         "coordinating agent. A minimal three-message interaction protocol was defined, "
         "permitting the same agent contract to be implemented on a general-purpose "
         "computer, a single-board computer, a microcontroller and a web browser.")
    para(document,
         "The coordinating agent implements adjudication against security posture, "
         "duplicate suppression, liveness invigilation, two-level access control, "
         "notification, scheduled posture changes, history aggregation and an audit "
         "trail. An operator interface presents the system state and explains its "
         "refusals. The system was evaluated across eight simulation scenarios and "
         "through automated testing at both unit and end-to-end level.")

    heading(document, "5.2 Achievement of Objectives", 2)
    data_table(document, ["Objective", "Status", "Evidence"], [
        ("Agent-based architecture, independent failure", "Achieved",
         "Section 3.5; Scenario 6"),
        ("Autonomous motion, door and camera agents", "Achieved", "Section 4.5"),
        ("Context-sensitive decision logic", "Achieved",
         "Section 3.8.1; Scenarios 1 to 4"),
        ("Detection of agent silence", "Achieved", "Section 3.8.3; Scenario 6"),
        ("Role and attribute based access control", "Achieved",
         "Section 3.8.4; Scenario 7"),
        ("Evaluation by simulation and testing", "Achieved", "Sections 4.6 and 4.7"),
    ], caption="Achievement of stated objectives.", widths=[2.6, 1.0, 2.4])

    heading(document, "5.3 Limitations of the Work", 2)
    para(document, "Four limitations are stated explicitly.")
    bullets(document, [
        "The hardware drivers for physical infrared and magnetic sensors remain "
        "documented stubs. The camera hardware path is complete and tested, but the two "
        "contact-sensor paths raise an explicit not-implemented condition and require "
        "the driver calls to be enabled and tested on a device.",
        "Credentials are shared per role rather than issued per person, so the audit "
        "trail can attribute an action to a role but not to an individual. The interface "
        "states this rather than implying an identity it cannot establish.",
        "The microcontroller firmware has been written and its logic tested "
        "independently, but its on-device paths remain unverified pending hardware.",
        "Evaluation used simulated stimuli. While the agents, protocol, coordination "
        "logic and persistence are the real implementations, the physical detection "
        "characteristics of an infrared sensor in a real corridor have not been measured.",
    ])

    heading(document, "5.4 Recommendations for Future Work", 2)
    bullets(document, [
        "Complete and field-test the contact-sensor drivers, and deploy at least one "
        "sensing point on physical hardware in a real corridor.",
        "Introduce per-user credentials so the audit trail can attribute actions to "
        "individuals rather than roles, strengthening its evidential value.",
        "Extend the camera agent from motion detection to classification, so a person may "
        "be distinguished from an animal or a moving curtain, which is the largest single "
        "source of false alarms in practice.",
        "Investigate limited peer-to-peer coordination between neighbouring camera "
        "agents, permitting a subject to be tracked across fields of view without routing "
        "every decision through the coordinating agent.",
        "Evaluate resilience by deliberately partitioning the network during operation, "
        "measuring how much history the buffering in each agent preserves.",
    ])

    heading(document, "5.5 Conclusion", 2)
    para(document,
         "The project demonstrates that an agent-oriented decomposition is well matched "
         "to physical security monitoring. Placing autonomous agents at each point of "
         "interest and centralising judgement in a coordinating agent yielded a system in "
         "which sensing points may be added, removed or replaced without reconfiguration, "
         "while decisions about what constitutes an intrusion remain consistent.")
    para(document,
         "Three findings are worth carrying forward. The absence of a signal is itself a "
         "signal, and a security system that does not reason about silence cannot detect "
         "the tampering it most needs to detect. A record is only worth keeping if it is "
         "honest about what it can establish, which is why the audit trail distinguishes "
         "a verified role from a claimed name. And software that passes its tests may "
         "nonetheless be entirely inert, which is why verification against real "
         "infrastructure earned its place in the methodology rather than being treated as "
         "an optional refinement.")


def build_back_matter(document):
    page_break(document)
    heading(document, "REFERENCES", 1)
    for reference in [
        "Fielding, R. T. (2000) Architectural Styles and the Design of Network-based "
        "Software Architectures. PhD thesis. University of California, Irvine.",
        "Foundation for Intelligent Physical Agents (2002) FIPA Abstract Architecture "
        "Specification. Geneva: FIPA.",
        "Jennings, N. R. (2001) 'An Agent-Based Approach for Building Complex Software "
        "Systems', Communications of the ACM, 44(4), pp. 35-41.",
        "Russell, S. and Norvig, P. (2021) Artificial Intelligence: A Modern Approach. "
        "4th edn. Harlow: Pearson Education.",
        "Sandhu, R. S., Coyne, E. J., Feinstein, H. L. and Youman, C. E. (1996) "
        "'Role-Based Access Control Models', IEEE Computer, 29(2), pp. 38-47.",
        "Wooldridge, M. (2009) An Introduction to MultiAgent Systems. 2nd edn. "
        "Chichester: John Wiley and Sons.",
        "Wooldridge, M., Jennings, N. R. and Kinny, D. (2000) 'The Gaia Methodology for "
        "Agent-Oriented Analysis and Design', Autonomous Agents and Multi-Agent Systems, "
        "3(3), pp. 285-312.",
        "Zivkovic, Z. (2004) 'Improved Adaptive Gaussian Mixture Model for Background "
        "Subtraction', Proceedings of the 17th International Conference on Pattern "
        "Recognition, pp. 28-31.",
    ]:
        p = para(document, reference)
        p.paragraph_format.left_indent = Inches(0.5)
        p.paragraph_format.first_line_indent = Inches(-0.5)

    page_break(document)
    heading(document, "APPENDICES", 1)

    heading(document, "Appendix A: Source Code Listing", 2)
    para(document,
         "The complete source is organised as a single repository with four components. "
         "The structure below indicates where each element described in this report is "
         "implemented.")
    data_table(document, ["Path", "Contents"], [
        ("hub/src/agents/", "Agent registry, enrolment, liveness invigilation"),
        ("hub/src/events/", "Observation ingestion and retrieval"),
        ("hub/src/alerts/", "Adjudication rules and duplicate suppression"),
        ("hub/src/cameras/", "Frame store, live video streaming, provisioning"),
        ("hub/src/schedules/", "Scheduled posture changes and their evaluator"),
        ("hub/src/audit/", "Audit trail recording and retrieval"),
        ("hub/src/maintenance/", "History aggregation and retention"),
        ("hub/src/common/security/", "Credentials, role and attribute based control"),
        ("hub/prisma/schema.prisma", "Entity definitions and migrations"),
        ("dashboard/src/", "Operator interface"),
        ("agents/security_agent/", "Motion, door and camera sensing agents"),
        ("agents/firmware/esp32/", "Microcontroller sensing node firmware"),
        ("packages/contracts/src/", "Shared interaction contract"),
        ("hub/scripts/verify-*.cjs", "End-to-end verification programs"),
        ("docs/report/", "This report and the programs that generate it"),
    ], caption="Repository structure.", widths=[2.4, 3.6])

    heading(document, "Appendix B: Full Message Catalogue", 2)
    para(document,
         "All agent communication uses JSON over HTTP, authenticated by a bearer "
         "credential. An agent presents the enrolment secret once and thereafter uses the "
         "credential issued to it.")
    data_table(document, ["Message", "Endpoint", "Payload", "Response"], [
        ("Enrol", "POST /agents/register", "id, type, location, capabilities",
         "Issued credential, shown once"),
        ("Heartbeat", "POST /agents/{id}/heartbeat", "(none)",
         "Acknowledgement and interval"),
        ("Report", "POST /events", "agentId, type, occurredAt, metadata",
         "Stored observation and any alert"),
        ("Frame", "POST /cameras/{id}/frame", "Encoded image bytes", "Acknowledgement"),
        ("Ticket", "POST /cameras/{id}/ticket", "(none)",
         "Single-use token for a stream"),
        ("Stream", "GET /cameras/{id}/stream", "Ticket as query parameter",
         "Continuous multipart images"),
        ("Posture", "POST /system/mode", "mode", "New posture, or refusal with reason"),
        ("Acknowledge", "POST /alerts/{id}/ack", "(none)",
         "Updated alert, or refusal with reason"),
    ], caption="Complete message catalogue.", widths=[1.0, 1.7, 1.8, 1.5])
    para(document,
         "Observation types are motion_detected, door_opened, door_closed and "
         "camera_motion. Alert types are intrusion_motion, intrusion_door, camera_motion, "
         "agent_offline and agent_recovered, each carrying a severity of info, warning or "
         "critical. Every value is defined once in the shared contract and mirrored by "
         "hand in the sensing agents, so a divergence surfaces as a test failure rather "
         "than as a rejected message in operation.")


# ------------------------------------------------------------------------- main


def main():
    document = Document()
    configure_styles(document)

    for section in document.sections:
        section.top_margin = Inches(1)
        section.bottom_margin = Inches(1)
        section.left_margin = Inches(1.25)
        section.right_margin = Inches(1)

    add_page_numbers(document)

    build_cover(document)
    page_break(document)
    build_members(document)
    page_break(document)
    build_abstract(document)
    page_break(document)
    build_toc(document)
    page_break(document)
    build_abbreviations(document)
    page_break(document)

    chapter_one(document)
    page_break(document)
    chapter_two(document)
    page_break(document)
    chapter_three(document)
    page_break(document)
    chapter_four(document)
    page_break(document)
    chapter_five(document)
    build_back_matter(document)

    # Word holds an exclusive lock on an open document, and rebuilding while reviewing the
    # previous version is the normal way to work. Falling back to a numbered file beats
    # failing outright and losing the build.
    target = OUTPUT
    try:
        document.save(target)
    except PermissionError:
        base, ext = os.path.splitext(OUTPUT)
        index = 2
        while os.path.exists("%s_v%d%s" % (base, index, ext)):
            index += 1
        target = "%s_v%d%s" % (base, index, ext)
        document.save(target)
        print("NOTE: %s is open in Word, so this build went to a new file."
              % os.path.basename(OUTPUT))

    print("Wrote %s" % target)
    print("  figures: %d   tables: %d" % (FIGURE_NUMBER["n"], TABLE_NUMBER["n"]))


if __name__ == "__main__":
    main()
