import { z } from 'zod'
import { GoogleSolusServer } from './google'
import { solusTool, vendorJson, type VendorAnswer } from './solus-server'

/**
 * Google Forms as a Solus MCP server (docs/plans/mcp-integrations.md §13.6):
 * Google publishes no usable Forms MCP server. The tools read a form and its
 * responses, create a form, and add, change, and delete its questions over
 * the Forms API v1. Both scopes are sensitive, not restricted.
 */

const API = 'https://forms.googleapis.com/v1/forms'

/** `forms.body` reads and writes forms; `forms.responses.readonly` reads their responses. */
export const GOOGLE_FORMS_SCOPES = [
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
] as const

const formId = z.string().min(1).describe('A form id, or the form\'s edit URL, such as https://docs.google.com/forms/d/<id>/edit.')

/** The form id in an id or an edit URL. A responder URL carries a published id, which the API does not take. */
function formIdOf(value: string): string {
  const text = value.trim()
  if (/\/forms\/d\/e\//.test(text)) {
    throw new Error('That is the form\'s responder URL (/forms/d/e/…/viewform). Its id is not the form id. Give the edit URL (/forms/d/<id>/edit) or the form id.')
  }
  const fromUrl = /\/forms\/d\/([\w-]+)/.exec(text)
  if (fromUrl?.[1]) return fromUrl[1]
  if (/^[\w-]+$/.test(text)) return text
  throw new Error(`Not a form id or form URL: ${value}`)
}

const optionSchema = z.object({ value: z.string().optional(), isOther: z.boolean().optional() })

const questionSchema = z.object({
  questionId: z.string().optional(),
  required: z.boolean().optional(),
  choiceQuestion: z.object({ type: z.string().optional(), options: z.array(optionSchema).optional() }).optional(),
  textQuestion: z.object({ paragraph: z.boolean().optional() }).optional(),
  scaleQuestion: z.object({ low: z.number().optional(), high: z.number().optional() }).optional(),
  dateQuestion: z.object({}).optional(),
  timeQuestion: z.object({}).optional(),
  ratingQuestion: z.object({}).optional(),
  fileUploadQuestion: z.object({}).optional(),
})

const itemSchema = z.object({
  itemId: z.string().optional(),
  title: z.string().optional(),
  questionItem: z.object({ question: questionSchema }).optional(),
  questionGroupItem: z.object({
    questions: z.array(questionSchema.extend({ rowQuestion: z.object({ title: z.string().optional() }).optional() })).optional(),
    grid: z.object({ columns: z.object({ options: z.array(optionSchema).optional() }).optional() }).optional(),
  }).optional(),
  pageBreakItem: z.object({}).optional(),
  textItem: z.object({}).optional(),
  imageItem: z.object({}).optional(),
  videoItem: z.object({}).optional(),
})

const formSchema = z.object({
  formId: z.string(),
  responderUri: z.string().optional(),
  info: z.object({ title: z.string().optional(), description: z.string().optional(), documentTitle: z.string().optional() }).optional(),
  items: z.array(itemSchema).optional(),
})

type FormItem = z.output<typeof itemSchema>
type FormQuestion = z.output<typeof questionSchema>

/** A question's kind in the words add_question uses, or the API's own name for the rest. */
function questionType(question: FormQuestion): string {
  if (question.choiceQuestion) {
    const type = question.choiceQuestion.type
    if (type === 'RADIO') return 'multiple_choice'
    if (type === 'CHECKBOX') return 'checkbox'
    if (type === 'DROP_DOWN') return 'dropdown'
    return 'choice'
  }
  if (question.textQuestion) return question.textQuestion.paragraph ? 'paragraph' : 'text'
  if (question.scaleQuestion) return 'scale'
  if (question.dateQuestion) return 'date'
  if (question.timeQuestion) return 'time'
  if (question.ratingQuestion) return 'rating'
  if (question.fileUploadQuestion) return 'file_upload'
  return 'question'
}

function itemType(item: FormItem): string {
  if (item.questionItem) return questionType(item.questionItem.question)
  if (item.questionGroupItem) return 'grid'
  if (item.pageBreakItem) return 'page_break'
  if (item.textItem) return 'text_block'
  if (item.imageItem) return 'image'
  if (item.videoItem) return 'video'
  return 'item'
}

function optionsOf(item: FormItem): string[] | null {
  const options = item.questionItem?.question.choiceQuestion?.options ?? item.questionGroupItem?.grid?.columns?.options
  return options ? options.map((option) => option.isOther ? '(Other)' : option.value ?? '') : null
}

/** An item as an agent reads it; `index` is the place delete_item and add_question take. */
function itemSummary(item: FormItem, index: number): VendorAnswer {
  const question = item.questionItem?.question
  const scale = question?.scaleQuestion
  return {
    index,
    itemId: item.itemId ?? null,
    title: item.title ?? '',
    type: itemType(item),
    required: question?.required ?? false,
    options: optionsOf(item),
    scale: scale ? { low: scale.low ?? 0, high: scale.high ?? 0 } : null,
    rows: item.questionGroupItem?.questions?.map((row) => row.rowQuestion?.title ?? '') ?? null,
  }
}

/** Question ids to the titles responses are read with; a grid row reads as `grid — row`. */
function questionTitles(items: FormItem[]): Map<string, string> {
  const titles = new Map<string, string>()
  for (const item of items) {
    const id = item.questionItem?.question.questionId
    if (id) titles.set(id, item.title ?? id)
    for (const row of item.questionGroupItem?.questions ?? []) {
      if (row.questionId) titles.set(row.questionId, `${item.title ?? ''} — ${row.rowQuestion?.title ?? ''}`)
    }
  }
  return titles
}

const answerSchema = z.object({
  textAnswers: z.object({ answers: z.array(z.object({ value: z.string().optional() })).optional() }).optional(),
  fileUploadAnswers: z.object({ answers: z.array(z.object({ fileId: z.string().optional(), fileName: z.string().optional() })).optional() }).optional(),
})

const responsesSchema = z.object({
  responses: z.array(z.object({
    responseId: z.string(),
    createTime: z.string().optional(),
    lastSubmittedTime: z.string().optional(),
    respondentEmail: z.string().optional(),
    answers: z.record(z.string(), answerSchema).optional(),
  })).optional(),
  nextPageToken: z.string().optional(),
})

function answerValues(answer: z.output<typeof answerSchema>): string[] {
  const text = answer.textAnswers?.answers?.map((value) => value.value ?? '') ?? []
  const files = answer.fileUploadAnswers?.answers?.map((file) => `${file.fileName ?? 'file'} (${file.fileId ?? ''})`) ?? []
  return [...text, ...files]
}

type QuestionKind = 'text' | 'paragraph' | 'multiple_choice' | 'checkbox' | 'dropdown' | 'scale'

const CHOICE_TYPES = { multiple_choice: 'RADIO', checkbox: 'CHECKBOX', dropdown: 'DROP_DOWN' } as const

interface QuestionInput {
  type: QuestionKind
  required: boolean
  options?: string[]
  low: number
  high: number
  lowLabel?: string
  highLabel?: string
}

/** A Forms API question, as add_question sends it. */
interface QuestionBody {
  required: boolean
  textQuestion?: { paragraph: boolean }
  scaleQuestion?: { low: number, high: number, lowLabel?: string, highLabel?: string }
  choiceQuestion?: { type: (typeof CHOICE_TYPES)[keyof typeof CHOICE_TYPES], options: { value: string }[] }
}

/** The batchUpdate requests these tools send. */
type FormRequest =
  | { createItem: { item: { title: string, description?: string, questionItem: { question: QuestionBody } }, location: { index: number } } }
  | { updateFormInfo: { info: { title?: string, description?: string }, updateMask: string } }
  | { deleteItem: { location: { index: number } } }

/** The Forms API's question for one add_question call. */
function questionBody(input: QuestionInput): QuestionBody {
  const { type, required } = input
  if (type === 'text' || type === 'paragraph') return { required, textQuestion: { paragraph: type === 'paragraph' } }
  if (type === 'scale') return { required, scaleQuestion: { low: input.low, high: input.high, lowLabel: input.lowLabel, highLabel: input.highLabel } }
  if (!input.options?.length) throw new Error(`A ${type} question needs options.`)
  return { required, choiceQuestion: { type: CHOICE_TYPES[type], options: input.options.map((value) => ({ value })) } }
}

async function readForm(fetch: (url: string) => Promise<Response>, id: string): Promise<z.output<typeof formSchema>> {
  return formSchema.parse(await vendorJson(await fetch(`${API}/${encodeURIComponent(id)}`)))
}

function batchUpdate(id: string, requests: FormRequest[]): [string, { method: 'POST', body: string }] {
  return [`${API}/${encodeURIComponent(id)}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) }]
}

export const googleFormsServer = new GoogleSolusServer({
  id: 'google-forms',
  name: 'Google Forms',
  description: 'Forms, their questions, and their responses in Google Forms.',
  domain: 'forms.google.com',
  icon: 'https://ssl.gstatic.com/images/branding/product/2x/forms_2020q4_48dp.png',
  categories: ['productivity'],
  hosts: ['forms.googleapis.com'],
  scopes: GOOGLE_FORMS_SCOPES,
  tools: [
    solusTool({
      name: 'get_form',
      description: 'A form\'s title, description, responder link, and items in order, with each question\'s type and options.',
      input: z.object({ formId }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const form = await readForm(fetch, formIdOf(input.formId))
        return {
          formId: form.formId,
          title: form.info?.title ?? '',
          description: form.info?.description ?? '',
          responderUri: form.responderUri ?? null,
          items: (form.items ?? []).map(itemSummary),
        }
      },
    }),
    solusTool({
      name: 'list_responses',
      description: 'A form\'s responses, with each answer under its question\'s title.',
      input: z.object({
        formId,
        pageSize: z.number().int().min(1).max(5000).default(50),
        pageToken: z.string().optional().describe('The nextPageToken of an earlier call, for the next page.'),
        filter: z.string().optional().describe('Only responses after a time, such as `timestamp > 2026-10-01T00:00:00Z` (or `timestamp >= …`).'),
      }),
      readOnly: true,
      destructive: false,
      run: async (input, { fetch }) => {
        const id = formIdOf(input.formId)
        const params = new URLSearchParams({ pageSize: String(input.pageSize) })
        if (input.pageToken) params.set('pageToken', input.pageToken)
        if (input.filter) params.set('filter', input.filter)
        const [form, page] = await Promise.all([
          readForm(fetch, id),
          fetch(`${API}/${encodeURIComponent(id)}/responses?${params}`).then(vendorJson).then((answer) => responsesSchema.parse(answer)),
        ])
        const titles = questionTitles(form.items ?? [])
        return {
          responses: (page.responses ?? []).map((response) => ({
            responseId: response.responseId,
            createTime: response.createTime ?? null,
            lastSubmittedTime: response.lastSubmittedTime ?? null,
            respondentEmail: response.respondentEmail ?? null,
            answers: Object.entries(response.answers ?? {}).map(([questionId, answer]) => ({ question: titles.get(questionId) ?? questionId, values: answerValues(answer) })),
          })),
          nextPageToken: page.nextPageToken ?? null,
        }
      },
    }),
    solusTool({
      name: 'create_form',
      description: 'Create an empty form. Add questions with add_question.',
      input: z.object({
        title: z.string().min(1).describe('The title responders see.'),
        documentTitle: z.string().optional().describe('The file name in Drive; the title when not given.'),
        description: z.string().optional(),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        // The API takes only the titles on create; the description is a second call.
        const created = formSchema.parse(await vendorJson(await fetch(API, { method: 'POST', body: JSON.stringify({ info: { title: input.title, documentTitle: input.documentTitle } }) })))
        if (input.description) {
          await vendorJson(await fetch(...batchUpdate(created.formId, [{ updateFormInfo: { info: { description: input.description }, updateMask: 'description' } }])))
        }
        return {
          formId: created.formId,
          title: input.title,
          editUrl: `https://docs.google.com/forms/d/${created.formId}/edit`,
          responderUri: created.responderUri ?? null,
        }
      },
    }),
    solusTool({
      name: 'add_question',
      description: 'Add a question to a form, last unless an index is given.',
      input: z.object({
        formId,
        title: z.string().min(1).describe('The question.'),
        description: z.string().optional().describe('Help text under the question.'),
        type: z.enum(['text', 'paragraph', 'multiple_choice', 'checkbox', 'dropdown', 'scale']).describe('`text` is a short answer; `paragraph` a long one.'),
        options: z.array(z.string().min(1)).optional().describe('The choices, for multiple_choice, checkbox, and dropdown.'),
        required: z.boolean().default(false),
        low: z.number().int().min(0).max(1).default(1).describe('The lowest value of a scale: 0 or 1.'),
        high: z.number().int().min(2).max(10).default(5).describe('The highest value of a scale: 2 to 10.'),
        lowLabel: z.string().optional().describe('The label at the low end of a scale.'),
        highLabel: z.string().optional().describe('The label at the high end of a scale.'),
        index: z.number().int().min(0).optional().describe('The place among the form\'s items, from 0; last when not given.'),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        const id = formIdOf(input.formId)
        const question = questionBody(input)
        const index = input.index ?? (await readForm(fetch, id)).items?.length ?? 0
        const item = { title: input.title, description: input.description, questionItem: { question } }
        return vendorJson(await fetch(...batchUpdate(id, [{ createItem: { item, location: { index } } }])))
      },
    }),
    solusTool({
      name: 'update_form_info',
      description: 'Change a form\'s title or description. Fields not given stay as they are.',
      input: z.object({
        formId,
        title: z.string().min(1).optional(),
        description: z.string().optional().describe('An empty string clears it.'),
      }),
      readOnly: false,
      destructive: false,
      run: async (input, { fetch }) => {
        const mask = [input.title !== undefined ? 'title' : null, input.description !== undefined ? 'description' : null].filter((field) => field !== null)
        if (mask.length === 0) throw new Error('Give a title or a description.')
        const info = { title: input.title, description: input.description }
        return vendorJson(await fetch(...batchUpdate(formIdOf(input.formId), [{ updateFormInfo: { info, updateMask: mask.join(',') } }])))
      },
    }),
    solusTool({
      name: 'delete_item',
      description: 'Delete one item from a form by its index from get_form. Its responses\' answers to it are no longer shown.',
      input: z.object({ formId, index: z.number().int().min(0).describe('The item\'s index from get_form.') }),
      readOnly: false,
      destructive: true,
      run: async (input, { fetch }) => {
        await vendorJson(await fetch(...batchUpdate(formIdOf(input.formId), [{ deleteItem: { location: { index: input.index } } }])))
        return { deletedIndex: input.index }
      },
    }),
  ],
})
