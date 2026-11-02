# Detecção de encontros

CLI batch em JavaScript ES modules, sem dependências. Requer Node.js 22 ou superior.

```sh
npm run detect -- data/dataset1.txt outputs/dataset1.json
npm test
```

Entrada e saída aceitam caminhos arbitrários. Diretórios de destino são criados automaticamente. Para escolher o log: `--rejects outputs/rejeicoes.jsonl`. Entrada, saída e log precisam identificar arquivos distintos.

## Entrada

Cabeçalho obrigatório:

```text
idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida
```

IDs são inteiros não negativos seguros de JavaScript. Facção é um identificador opaco; vazio significa sem facção. Timestamp usa `YYYY-MM-DD HH:MM:SS`, opcionalmente entre aspas, com calendário validado. Coordenadas aceitam inteiros e decimais nas faixas [-90,90] e [-180,180], sem limite de cinco casas, com precisão IEEE 754. Não há trim automático.

Medida protetiva aceita `true` ou `false`. Restrições são IDs separados por vírgulas, opcionalmente entre aspas; vazio é permitido. Restrições com `false` não têm efeito. Aceita BOM UTF-8, LF, CRLF e última linha sem quebra. Apenas cabeçalho produz `[]`; arquivo vazio é inválido.

Duplicatas semanticamente idênticas são ignoradas e registradas. Dados inválidos e duplicatas conflitantes impedem publicação. Log informa linha original, motivo e trecho do registro. Código 0 indica publicação; código 1 indica falha e preserva a saída anterior.

## Regras

Compara somente timestamps iguais, usando Haversine com raio de **6.371.000 metros** e distância **menor ou igual a 20 metros**, conforme instrução atualizada do solicitante. Sem arredondamento na decisão.

Cada par aparece uma vez por timestamp, com prioridade:

1. `protetiva`: um participante com medida lista o ID do outro, inclusive quando ambos possuem medidas.
2. `faccao`: mesma facção não vazia.
3. `generico`: demais pares qualificados.

Objetos contêm exatamente `tipo`, `monitoradosEncontro`, `timestamp`, `posicoes` e `distanciaMetros`. IDs são crescentes; posições são indexadas por ID com `lat` e `lon`. Array final ordenado por timestamp e IDs.

## Algoritmo e limites

Leitor com buffer reutilizável, validação e grupos temporais em arrays Float64. Detector ordena por latitude, aplica janela conservadora e confirma candidatos por Haversine. Metadados são preservados por posição.

Entrada ordenada usa fluxo direto. Ao detectar inversão, descarta a tentativa e relê a entrada para ordenação externa automática: blocos de 100 mil registros, intercalação de até 32 arquivos por rodada e desempate por linha original. Temporários exclusivos no diretório temporário do sistema são removidos ao concluir ou falhar. Exige espaço em disco para as rodadas.

Pior caso O(k²) por grupo, por insertion sort e candidatos. Memória depende do buffer, maior linha, maior grupo, metadados e encontros acumulados. Blocos limitam registros, não bytes. JSON.stringify materializa a saída completa. Não há promessa de memória constante para volume ilimitado de encontros.

Publicação usa temporário no diretório de destino e renomeação após sucesso. Resumo vai para stderr. Não há API, banco ou build.

## Lote e testes

```powershell
Get-ChildItem data/dataset*.txt | ForEach-Object {
  node src/cli.js $_.FullName "outputs/$($_.BaseName).json"
  if ($LASTEXITCODE -ne 0) { throw "Falha em $($_.Name)" }
}
```

`npm test` executa testes sintéticos e compara datasets 1 e 2 locais em `data/` com gabaritos em `audit/`, sem rede. `node audit/download.mjs` permite conferir as cópias oficiais. Resultados estão em `audit/RELATORIO.md`; medições repetidas em `audit/benchmark-results.json`. Datasets 3–7 são verificações de regressão, não gabaritos oficiais.
