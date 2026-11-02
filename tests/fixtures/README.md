# Dados fictícios de validação

Cópias dos dois datasets públicos com gabaritos fornecidos no desafio:

- [dataset1.txt](https://bucket-projeto-trainee.s3.sa-east-1.amazonaws.com/dataset1.txt)
- [dataset2.txt](https://bucket-projeto-trainee.s3.sa-east-1.amazonaws.com/dataset2.txt)
- [respostas1.json](https://bucket-projeto-trainee.s3.sa-east-1.amazonaws.com/respostas1.json)
- [respostas2.json](https://bucket-projeto-trainee.s3.sa-east-1.amazonaws.com/respostas2.json)

Os arquivos são versionados para permitir testes sem rede. Para conferir se as cópias
continuam idênticas às fontes, execute `node tests/verify-fixtures.js` (requer rede).
Esse comando compara SHA-256, não altera arquivos e falha se houver divergência.
Os dados e os gabaritos não são gerados pelo algoritmo testado.

Os datasets 3–7 não têm gabaritos oficiais fornecidos e não estão nesta suíte.
