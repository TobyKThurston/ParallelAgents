import { RunView } from '../../../components/fork-tree'

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return <RunView runId={id} />
}
