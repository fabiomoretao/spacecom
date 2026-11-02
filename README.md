# Detecção de encontros

Solução em JavaScript para Node.js 22 ou superior, sem dependências externas.

## Execução

Baixe o dataset desejado (`dataset1.txt` a `dataset7.txt`) dos links do desafio. [Exemplo: dataset 1](https://bucket-projeto-trainee.s3.sa-east-1.amazonaws.com/dataset1.txt).

```sh
npm run detect -- caminho/dataset1.txt outputs/dataset1.json
```

Os diretórios de saída são criados automaticamente. Os sete JSONs gerados estão em `outputs/`.

## Lógica

Os registros são agrupados pelo timestamp exato. Dentro de cada grupo, as posições são ordenadas por latitude para descartar pares cuja separação nessa coordenada já excede o limite. Os candidatos são confirmados pela fórmula de Haversine, com raio da Terra de **6.371.000 metros** e distância **estritamente menor que 20 metros**, sem arredondamento na decisão.

Cada par aparece uma vez por timestamp, com prioridade:

1. `protetiva`: um participante possui medida protetiva e lista o ID do outro em suas restrições.
2. `faccao`: os participantes têm a mesma facção não vazia.
3. `generico`: demais pares dentro do limite.

A saída contém `tipo`, `monitoradosEncontro`, `timestamp`, `posicoes` e `distanciaMetros`, ordenada por timestamp e IDs.

## Escolha da abordagem

A leitura em blocos evita carregar todo o arquivo de entrada em memória. O agrupamento temporal elimina comparações entre horários distintos, e a janela por latitude reduz os cálculos de Haversine sem aproximar a decisão. Entradas desordenadas são ordenadas externamente em disco.

O pior caso é O(k²) por grupo de k posições. A memória depende do maior grupo, dos metadados e dos encontros acumulados; o JSON final é materializado em memória.

Duplicatas idênticas são ignoradas. Registros inválidos ou conflitantes encerram a execução com código 1 e preservam a saída anterior. Rejeições são registradas em `<saida>.rejects.jsonl`; o resumo da execução é escrito em stderr.
